import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AuthAnswer, AuthPrompt, ChoicePrompt, RdpStatus } from '../../shared/ipc';
import type { RdpSession } from '../../shared/session';
import type { Platform } from '../platform/types';
import type { RdpCerts } from '../store/rdp-certs';
import type { SecretStore } from '../store/secrets';
import type { TunnelManager } from '../ssh/tunnels';
import { freerdpArgs, type FreerdpTarget } from './freerdp-args';
import { mstscCredTarget, mstscFile } from './mstsc-file';

const LOG_LINES = 40;
/** A connection alive this long is taken as "the password worked" (FreeRDP gives no explicit signal). */
const SAVE_AFTER_MS = 15_000;
const THUMBPRINT = /^[0-9a-f]{2}(:[0-9a-f]{2}){31}$/;

export interface CertRejection {
  thumbprint: string;
  /** FreeRDP's "Certificate details" block, for the user. */
  details: string;
}

/**
 * Collects FreeRDP's console output. Without a terminal FreeRDP cannot ask about unknown
 * certificates: it prints their details and aborts. We parse that to ask the user ourselves.
 */
export class FreerdpOutput {
  private all = '';
  readonly log: string[] = [];

  feed(chunk: string): void {
    this.all += chunk;
    if (this.all.length > 256_000) this.all = this.all.slice(-64_000);
    for (const line of chunk.split('\n')) if (line.trim()) this.log.push(line.trimEnd());
    this.log.splice(0, Math.max(0, this.log.length - LOG_LINES));
  }

  /** The certificate FreeRDP refused, if that is why it stopped. */
  certRejection(): CertRejection | null {
    if (!/certificate not trusted|ERRCONNECT_TLS_CONNECT_FAILED/.test(this.all)) return null;
    const start = this.all.lastIndexOf('Certificate details for');
    if (start < 0) return null;
    const block = this.all.slice(start).split('\n');
    const end = block.findIndex((l, i) => i > 0 && !l.startsWith('\t'));
    const details = block.slice(0, end < 0 ? undefined : end).join('\n').trim();
    const thumbprint = /Thumbprint:\s*([0-9a-f:]+)/i.exec(details)?.[1].toLowerCase();
    return thumbprint && THUMBPRINT.test(thumbprint) ? { thumbprint, details } : null;
  }

  /** The most useful error lines for the user. */
  errors(): string {
    const errs = this.log.filter((l) => /ERROR|ERRCONNECT|failed/i.test(l));
    return (errs.length ? errs : this.log).slice(-4).map((l) => l.replace(/^(\[[^\]]*\]\s*)+-\s*/, '')).join('\n');
  }
}

export interface RdpDeps {
  platform: Pick<Platform, 'rdpClient' | 'focusWindow' | 'rdpCredential'>;
  tunnels: Pick<TunnelManager, 'ephemeral'>;
  secrets: Pick<SecretStore, 'get' | 'set' | 'canStore'>;
  certs: Pick<RdpCerts, 'get' | 'set'>;
  askAuth(p: AuthPrompt): Promise<AuthAnswer>;
  askChoice(p: ChoicePrompt): Promise<string | null>;
  emit(s: RdpStatus): void;
}

/** Launches external RDP client windows (FreeRDP or mstsc); one per RDP tab. */
export class RdpLauncher {
  private procs = new Map<string, ChildProcess>();
  private stopped = new Set<string>();

  constructor(private readonly deps: RdpDeps) {}

  async launch(rdpId: string, s: RdpSession): Promise<void> {
    const emit = (state: RdpStatus['state'], error?: string) => this.deps.emit({ rdpId, state, error });
    emit('starting');
    this.stopped.delete(rdpId);
    let tunnel: { port: number; close(): void } | undefined;
    try {
      const client = this.deps.platform.rdpClient();
      if ('error' in client) throw new Error(client.error);

      let password = this.deps.secrets.get(s.id, 'password');
      let save = false;
      if (!password) {
        const a = await this.deps.askAuth({ title: `${s.domain ? s.domain + '\\' : ''}${s.username}@${s.host}`, label: 'Contraseña', canSave: this.deps.secrets.canStore() });
        if (!a) throw new Error('Cancelado');
        ({ value: password, save } = a);
      }

      let target = { host: s.host, port: s.port };
      if (s.viaSshSessionId) {
        tunnel = await this.deps.tunnels.ephemeral(s.viaSshSessionId, s.host, s.port);
        target = { host: '127.0.0.1', port: tunnel.port };
      }

      if (client.kind === 'mstsc') {
        // mstsc shows its own certificate dialogs, and its exit code means nothing.
        await this.runMstsc(rdpId, client.path, s, target, password, save, emit);
        return emit('exited');
      }

      // The certificate is pinned to the real server, also when going through a tunnel.
      const certKey = `${s.host}:${s.port}`;
      let pin = this.deps.certs.get(certKey);
      for (let attempt = 0; ; attempt++) {
        const r = await this.run(rdpId, client.path, freerdpArgs(s, { ...target, thumbprint: pin }), password, save, s.id, emit);
        if (r.ok || this.stopped.has(rdpId)) return emit('exited');
        const rej = r.out.certRejection();
        if (!rej || attempt > 0) return emit('error', r.out.errors() || 'FreeRDP terminó con error');
        const trusted = await this.askCert(s, rej, this.deps.certs.get(certKey));
        if (!trusted) return emit('error', 'Certificado rechazado');
        if (trusted === 'always') this.deps.certs.set(certKey, rej.thumbprint);
        pin = rej.thumbprint;
        emit('starting');
      }
    } catch (e) {
      emit('error', e instanceof Error ? e.message : String(e));
    } finally {
      tunnel?.close();
    }
  }

  focus(rdpId: string): Promise<boolean> {
    const pid = this.procs.get(rdpId)?.pid;
    return pid ? this.deps.platform.focusWindow(pid) : Promise.resolve(false);
  }

  stop(rdpId: string): void {
    this.stopped.add(rdpId);
    this.procs.get(rdpId)?.kill('SIGTERM');
  }

  stopAll(): void {
    for (const id of this.procs.keys()) this.stop(id);
  }

  /** mstsc reads the password from Credential Manager; the entry lives only while mstsc runs. */
  private async runMstsc(
    rdpId: string,
    exe: string,
    s: RdpSession,
    target: FreerdpTarget,
    password: string,
    save: boolean,
    emit: (state: RdpStatus['state'], error?: string) => void,
  ): Promise<void> {
    const cred = mstscCredTarget(target.host);
    const user = `${s.domain ? `${s.domain}\\` : ''}${s.username}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'estela-rdp-'));
    try {
      // The file name shows in mstsc's title bar.
      const file = path.join(dir, `${s.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}.rdp`);
      fs.writeFileSync(file, '\ufeff' + mstscFile(s, target, path.parse(os.homedir()).root), 'utf16le');
      await this.deps.platform.rdpCredential(cred, user, password);
      await this.run(rdpId, exe, [file], password, save, s.id, emit, false);
    } finally {
      await this.deps.platform.rdpCredential(cred, user, null).catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /** One client run; resolves when it exits. FreeRDP gets the password on stdin. */
  private run(
    rdpId: string,
    file: string,
    args: string[],
    password: string,
    save: boolean,
    sessionId: string,
    emit: (state: RdpStatus['state'], error?: string) => void,
    passwordOnStdin = true,
  ): Promise<{ ok: boolean; out: FreerdpOutput }> {
    return new Promise((resolve) => {
      const out = new FreerdpOutput();
      const proc = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      this.procs.set(rdpId, proc);
      // /from-stdin:force reads the password from here before connecting: never on the command line.
      if (passwordOnStdin) proc.stdin.write(password + '\n');
      proc.stdout.on('data', (d: Buffer) => out.feed(d.toString('utf8')));
      proc.stderr.on('data', (d: Buffer) => out.feed(d.toString('utf8')));
      const saveTimer = save ? setTimeout(() => this.deps.secrets.set(sessionId, 'password', password), SAVE_AFTER_MS) : undefined;
      const done = (ok: boolean) => {
        clearTimeout(saveTimer);
        this.procs.delete(rdpId);
        resolve({ ok, out });
      };
      proc.on('error', (e) => (out.feed(`ERROR ${e.message}\n`), done(false)));
      proc.on('exit', (code, signal) => done(code === 0 || signal === 'SIGTERM'));
      emit('running');
    });
  }

  private async askCert(s: RdpSession, rej: CertRejection, previous?: string): Promise<'always' | 'once' | null> {
    const changed = !!previous && previous !== rej.thumbprint;
    const intro = changed
      ? '¡El certificado de este servidor ha CAMBIADO desde la última vez!\nPuede ser una renovación… o alguien interceptando la conexión.\n\n' +
        `Huella anterior:\n  ${previous}\n\n`
      : 'Es la primera vez que te conectas a este servidor (o su certificado no está firmado por una CA de confianza).\n\n';
    const answer = await this.deps.askChoice({
      title: `Certificado de ${s.host}:${s.port}`,
      text: intro + rej.details,
      warning: changed,
      choices: [
        { value: 'no', label: 'Rechazar' },
        { value: 'once', label: 'Solo esta vez' },
        { value: 'always', label: changed ? 'Reemplazar el guardado' : 'Confiar siempre', primary: true },
      ],
    });
    return answer === 'always' || answer === 'once' ? answer : null;
  }
}
