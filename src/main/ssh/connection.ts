import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { Client, utils, type AnyAuthMethod, type AuthenticationType, type ClientChannel, type Prompt, type SFTPWrapper } from 'ssh2';
import type { AuthAnswer, AuthPrompt, ConnStatus, HostKeyAnswer, HostKeyPrompt } from '../../shared/ipc';
import type { SecretKind, Session, SshSession } from '../../shared/session';
import { expandHome } from '../paths';
import { fingerprint, keyType, type KnownHosts } from '../store/known-hosts';
import type { SecretStore } from '../store/secrets';
import { ShellHook, hookScript } from './shell-hook';

export interface ConnectionDeps {
  findSession(id: string): Session | undefined;
  secrets: Pick<SecretStore, 'get' | 'set' | 'canStore'>;
  knownHosts: Pick<KnownHosts, 'check' | 'add'>;
  agent(): string | undefined;
  askHostKey(p: HostKeyPrompt): Promise<HostKeyAnswer>;
  askAuth(p: AuthPrompt): Promise<AuthAnswer>;
  /** SSH keepalive interval in seconds (0 = off). Default 30. */
  keepaliveSec?(): number;
}

export interface ShellEvents {
  data(d: string): void;
  status(s: ConnStatus, error?: string): void;
  hook(result: { installed: boolean; pid?: number }): void;
}

const TCP_TIMEOUT_MS = 15_000;
const MAX_JUMPS = 5;
const MAX_PASSWORD_TRIES = 3;
const EXEC_TIMEOUT_MS = 5_000;
/** Until the server shows its host key; user prompts come later and are not counted. */
const HANDSHAKE_TIMEOUT_MS = 20_000;

/**
 * An authenticated SSH connection to a session, through its chain of jump hosts.
 * Used by interactive shells, tunnels and RDP-over-SSH.
 */
export class SshConnection {
  private clients: Client[] = [];
  private target?: Client;
  private sftpChannel?: Promise<SFTPWrapper>;
  private closed = false;
  /** Last error reported by the target client (e.g. keepalive timeout). */
  lastError?: string;

  constructor(private readonly deps: ConnectionDeps) {}

  get isClosed(): boolean {
    return this.closed;
  }

  async connect(sessionId: string): Promise<Client> {
    const client = await this.connectChain(this.session(sessionId), 0);
    if (this.closed) throw new Error('Connection closed');
    this.target = client;
    return client;
  }

  /** Called once when the target connection goes away (not when we close it ourselves). */
  onDrop(cb: () => void): void {
    this.target?.once('close', () => {
      if (!this.closed) cb();
    });
  }

  /** Shared SFTP channel for listings and small operations. */
  sftp(): Promise<SFTPWrapper> {
    this.sftpChannel ??= this.openSftp().then((s) => {
      s.on('close', () => (this.sftpChannel = undefined));
      return s;
    });
    this.sftpChannel.catch(() => (this.sftpChannel = undefined));
    return this.sftpChannel;
  }

  /** A dedicated SFTP channel; transfers use one each so cancelling = closing it. */
  openSftp(): Promise<SFTPWrapper> {
    const c = this.target;
    if (!c) return Promise.reject(new Error('Not connected'));
    return new Promise((resolve, reject) => c.sftp((err, s) => (err ? reject(err) : resolve(s))));
  }

  /** Runs a command on a separate channel and returns its stdout. */
  exec(cmd: string): Promise<string> {
    const c = this.target;
    if (!c) return Promise.reject(new Error('Not connected'));
    return new Promise((resolve, reject) => {
      // Some devices (routers, appliances) never answer exec requests.
      const timer = setTimeout(() => reject(new Error('exec timed out')), EXEC_TIMEOUT_MS);
      c.exec(cmd, (err, ch) => {
        if (err) return clearTimeout(timer), reject(err);
        let out = '';
        ch.on('data', (d: Buffer) => (out += d.toString('utf8')));
        ch.stderr.resume();
        ch.on('close', () => {
          clearTimeout(timer);
          resolve(out);
        });
      });
    });
  }

  close(): void {
    this.closed = true;
    for (const c of this.clients) c.end();
    this.clients = [];
    this.target = undefined;
  }

  session(id: string): SshSession {
    const s = this.deps.findSession(id);
    if (!s) throw new Error(`Session ${id} not found`);
    if (s.type !== 'ssh') throw new Error(`Session ${s.name} is not an SSH session`);
    return s;
  }

  private async connectChain(s: SshSession, depth: number): Promise<Client> {
    if (depth > MAX_JUMPS) throw new Error('Too many chained jump hosts');
    let sock: Duplex;
    if (s.jumpSessionId) {
      const jump = await this.connectChain(this.session(s.jumpSessionId), depth + 1);
      sock = await new Promise<ClientChannel>((resolve, reject) =>
        jump.forwardOut('127.0.0.1', 0, s.host, s.port, (err, ch) => (err ? reject(err) : resolve(ch))),
      );
    } else {
      sock = await tcpConnect(s.host, s.port);
    }
    return this.connectClient(s, sock);
  }

  private async connectClient(s: SshSession, sock: Duplex): Promise<Client> {
    const client = new Client();
    this.clients.push(client);
    const auth = new AuthFlow(s, this.deps);
    await new Promise<void>((resolve, reject) => {
      const handshake = setTimeout(() => {
        this.lastError = `No SSH handshake from ${s.host} after ${HANDSHAKE_TIMEOUT_MS / 1000} s`;
        reject(new Error(this.lastError));
        sock.destroy();
      }, HANDSHAKE_TIMEOUT_MS);
      client.once('close', () => clearTimeout(handshake));
      client.once('ready', resolve);
      client.once('close', () => reject(new Error(`Connection to ${s.host} closed`)));
      // Permanent listener: an EventEmitter 'error' without listeners would crash the main process.
      client.on('error', (err) => {
        this.lastError = auth.error ?? err.message;
        reject(new Error(this.lastError));
      });
      client.connect({
        sock,
        username: s.username,
        // Disabled: ssh2 counts it until auth succeeds, which includes the time the user spends in our prompts.
        // HANDSHAKE_TIMEOUT_MS covers servers that accept TCP but never speak SSH.
        readyTimeout: 0,
        keepaliveInterval: (this.deps.keepaliveSec?.() ?? 30) * 1000,
        keepaliveCountMax: 3,
        hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
          clearTimeout(handshake);
          this.verifyHost(s, key).then(verify, () => verify(false));
        },
        authHandler: (methodsLeft, _partial, next) => {
          // ssh2 accepts `false` to stop authenticating; its typings don't say so.
          const stop = () => next(false as never);
          auth.next(methodsLeft).then((m) => (m ? next(m) : stop()), (e) => {
            auth.error = message(e);
            stop();
          });
        },
      });
    });
    auth.commit();
    return client;
  }

  private async verifyHost(s: SshSession, key: Buffer): Promise<boolean> {
    const check = this.deps.knownHosts.check(s.host, s.port, key);
    if (check.result === 'match') return true;
    const answer = await this.deps.askHostKey({
      host: s.host,
      port: s.port,
      keyType: keyType(key),
      fingerprint: fingerprint(key),
      oldFingerprint: check.result === 'changed' ? check.oldFingerprint : undefined,
    });
    if (answer === 'save') this.deps.knownHosts.add(s.host, s.port, key);
    if (answer === 'reject') throw new Error('Host key rejected');
    return true;
  }
}

/** One interactive shell = one pane. */
export class SshShell {
  readonly conn: SshConnection;
  private stream?: ClientChannel;
  private hook?: ShellHook;
  private closed = false;

  constructor(deps: ConnectionDeps, private readonly events: ShellEvents) {
    this.conn = new SshConnection(deps);
  }

  async open(sessionId: string, cols: number, rows: number): Promise<void> {
    this.events.status('connecting');
    try {
      const client = await this.conn.connect(sessionId);
      const session = this.conn.session(sessionId);
      // Ask for the login shell in parallel with opening it; the hook needs it ~300 ms later.
      const shellPath = this.conn.exec('echo "$SHELL"').catch(() => '');
      const stream = await new Promise<ClientChannel>((resolve, reject) =>
        client.shell({ term: 'xterm-256color', cols, rows }, (err, s) => (err ? reject(err) : resolve(s))),
      );
      if (this.closed) return void stream.close();
      this.stream = stream;
      stream.setEncoding('utf8');
      stream.stderr.setEncoding('utf8');
      const hook = (this.hook = new ShellHook(
        shellPath.then((sh) => hookScript(sh, session.initialDir)),
        (s) => stream.write(s),
        (d) => this.events.data(d),
        (r) => this.events.hook(r),
      ));
      stream.on('data', (d: string) => hook.data(d));
      stream.stderr.on('data', (d: string) => this.events.data(d));
      stream.on('close', () => {
        const err = this.conn.lastError;
        if (!this.closed) this.events.status(err ? 'error' : 'closed', err);
        this.close();
      });
      this.events.status('connected');
    } catch (e) {
      const wasClosed = this.closed;
      this.close();
      if (!wasClosed) this.events.status('error', message(e));
    }
  }

  write(data: string): void {
    this.hook?.userInput();
    this.stream?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.stream?.setWindow(rows, cols, 0, 0);
  }

  retryHook(): void {
    this.hook?.retry();
  }

  sftp = () => this.conn.sftp();
  openSftp = () => this.conn.openSftp();

  /** The shell's cwd via /proc, for shells without the OSC 7 hook. Null when unknown. */
  async cwd(): Promise<string | null> {
    if (!this.hook?.pid) return null;
    const out = await this.conn.exec(`readlink /proc/${this.hook.pid}/cwd`).catch(() => '');
    return out.startsWith('/') ? out.trim() : null;
  }

  close(): void {
    this.closed = true;
    this.hook?.dispose();
    this.stream?.close();
    this.conn.close();
  }
}

/** Drives ssh2's authHandler: the session's method first, then password / keyboard-interactive as fallback. */
class AuthFlow {
  error?: string;
  private primaryDone = false;
  private passwordTries = 0;
  private password?: string;
  private lastMethod?: AuthenticationType;
  private toSave = new Map<SecretKind, string>();

  constructor(private readonly s: SshSession, private readonly deps: ConnectionDeps) {}

  async next(methodsLeft: AuthenticationType[] | null): Promise<AnyAuthMethod | false> {
    const allowed = (m: AuthenticationType) => !methodsLeft || methodsLeft.includes(m);
    const username = this.s.username;

    if (!this.primaryDone) {
      this.primaryDone = true;
      if (this.s.auth === 'agent') {
        const agent = this.deps.agent();
        if (!agent) this.error = 'No SSH agent available (SSH_AUTH_SOCK is not set)';
        else if (allowed('publickey')) return (this.lastMethod = 'agent', { type: 'agent', username, agent });
      }
      if (this.s.auth === 'key' && allowed('publickey')) {
        return (this.lastMethod = 'publickey', { type: 'publickey', username, ...(await this.loadKey()) });
      }
    }

    const method = allowed('password') ? 'password' : allowed('keyboard-interactive') ? 'keyboard-interactive' : null;
    if (!method) return false;
    // A password just rejected by "password" is worth one retry over "keyboard-interactive" without re-asking.
    const reuse = this.password !== undefined && this.lastMethod === 'password' && method === 'keyboard-interactive';
    const password = reuse ? this.password! : await this.getPassword();
    if (password === null) return false;
    this.lastMethod = method;
    if (method === 'password') return { type: 'password', username, password };
    return {
      type: 'keyboard-interactive',
      username,
      prompt: (_name, _instr, _lang, prompts, finish) => {
        this.answerKeyboard(prompts, password).then(finish, () => finish([]));
      },
    };
  }

  /** Persist secrets the user asked to remember, only once they proved correct. */
  commit(): void {
    for (const [kind, value] of this.toSave) this.deps.secrets.set(this.s.id, kind, value);
  }

  private async getPassword(): Promise<string | null> {
    if (this.passwordTries++ >= MAX_PASSWORD_TRIES) return null;
    if (this.passwordTries === 1 && this.s.auth === 'password') {
      const stored = this.deps.secrets.get(this.s.id, 'password');
      if (stored) return (this.password = stored);
    }
    const a = await this.deps.askAuth({ title: this.title(), label: 'Contraseña', canSave: this.deps.secrets.canStore() });
    if (!a) return null;
    if (a.save) this.toSave.set('password', a.value);
    return (this.password = a.value);
  }

  private async answerKeyboard(prompts: Prompt[], password: string): Promise<string[]> {
    const answers: string[] = [];
    for (const p of prompts) {
      if (!p.echo && /pass/i.test(p.prompt)) answers.push(password);
      else {
        const a = await this.deps.askAuth({ title: this.title(), label: p.prompt.trim(), canSave: false });
        answers.push(a?.value ?? '');
      }
    }
    return answers;
  }

  private async loadKey(): Promise<{ key: Buffer; passphrase?: string }> {
    const file = expandHome(this.s.keyPath!);
    const key = fs.readFileSync(file);
    const plain = utils.parseKey(key);
    if (!(plain instanceof Error)) return { key };
    if (!/passphrase|encrypted/i.test(plain.message)) throw new Error(`Cannot read key ${file}: ${plain.message}`);

    const ok = (p: string) => !(utils.parseKey(key, p) instanceof Error);
    const stored = this.deps.secrets.get(this.s.id, 'passphrase');
    if (stored && ok(stored)) return { key, passphrase: stored };
    for (let i = 0; i < MAX_PASSWORD_TRIES; i++) {
      const a = await this.deps.askAuth({
        title: this.title(),
        label: `Passphrase de ${path.basename(file)}`,
        canSave: this.deps.secrets.canStore(),
      });
      if (!a) throw new Error('Authentication cancelled');
      if (ok(a.value)) {
        if (a.save) this.toSave.set('passphrase', a.value);
        return { key, passphrase: a.value };
      }
    }
    throw new Error('Wrong key passphrase');
  }

  private title(): string {
    return `${this.s.username}@${this.s.host}`;
  }
}

function tcpConnect(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    sock.setTimeout(TCP_TIMEOUT_MS, () => sock.destroy(new Error(`Timed out connecting to ${host}:${port}`)));
    sock.once('error', reject);
    sock.once('connect', () => {
      sock.setTimeout(0);
      resolve(sock);
    });
  });
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
