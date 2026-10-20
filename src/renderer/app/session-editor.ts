import { Component, ElementRef, OnInit, afterNextRender, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import type { RdpSession, SecretKind, Session, SshAuth, SshSession, Tunnel } from '../../shared/session';
import { COLORS, DEFAULT_SESSION_ICON } from './constants';
import { cleanError, estela } from './estela';
import { Icon } from './icon';
import { IconPicker } from './icon-picker';
import type { EditRequest } from './session-tree';
import { SessionsService } from './sessions.service';

const DEFAULT_RDP_ICON = '🪟';

@Component({
  selector: 'app-session-editor',
  imports: [ReactiveFormsModule, Icon, IconPicker],
  templateUrl: './session-editor.html',
  styles: `
    .icons, .colors { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
    .icons .current { font-size: 18px; padding: 2px 8px; }
    .colors span { width: 20px; height: 20px; border-radius: 4px; cursor: pointer; }
    .sel { outline: 2px solid var(--fg); }
    .warn { background: color-mix(in srgb, var(--warn) 20%, transparent); padding: 8px; border-radius: 4px; grid-column: 1 / -1; }
    .error { color: var(--danger); grid-column: 1 / -1; }
    .row { display: flex; gap: 4px; align-items: center; }
    .row input:not([type='checkbox']) { flex: 1; min-width: 0; }
    .wide { grid-column: 1 / -1; }
    .checks { display: flex; gap: 14px; flex-wrap: wrap; }
    h4 { grid-column: 1 / -1; margin: 8px 0 0; color: var(--fg-dim); font-weight: normal; border-top: 1px solid var(--border); padding-top: 8px; }
    .tunnel { display: grid; grid-template-columns: 52px 1fr 70px auto 1fr 70px auto auto; gap: 4px; align-items: center; grid-column: 1 / -1; }
    .tunnel input { min-width: 0; }
    form { max-height: 70vh; overflow: auto; padding-right: 4px; }
  `,
})
export class SessionEditor implements OnInit {
  readonly request = input.required<EditRequest>();
  readonly closed = output<void>();
  protected readonly sessions = inject(SessionsService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');

  protected readonly colors = COLORS;
  protected readonly pickingIcon = signal(false);
  protected readonly form = inject(NonNullableFormBuilder).group({
    type: ['ssh' as 'ssh' | 'rdp'],
    name: ['', Validators.required],
    host: ['', Validators.required],
    port: [22, [Validators.required, Validators.min(1), Validators.max(65535)]],
    username: ['', Validators.required],
    auth: ['password' as SshAuth],
    keyPath: [''],
    jumpSessionId: [''],
    initialDir: [''],
    folderId: [''],
    color: [COLORS[0]],
    icon: [DEFAULT_SESSION_ICON],
    secret: [''],
    clearSecret: [false],
    // RDP
    domain: [''],
    fullscreen: [true],
    width: [1600],
    height: [900],
    multimon: [false],
    clipboard: [true],
    drives: [false],
    gateway: [''],
    viaSshSessionId: [''],
  });
  protected readonly type = toSignal(this.form.controls.type.valueChanges, { initialValue: 'ssh' as 'ssh' | 'rdp' });
  protected readonly auth = toSignal(this.form.controls.auth.valueChanges, { initialValue: 'password' as SshAuth });
  protected readonly fullscreen = toSignal(this.form.controls.fullscreen.valueChanges, { initialValue: true });
  protected readonly secretKind = computed<SecretKind | null>(() =>
    this.type() === 'rdp' || this.auth() === 'password' ? 'password' : this.auth() === 'key' ? 'passphrase' : null,
  );
  protected readonly hasSecret = signal(false);
  protected readonly error = signal('');
  protected readonly tunnels = signal<Tunnel[]>([]);

  /** Other SSH sessions (jump host / RDP "through"). */
  protected readonly sshSessions = computed(() =>
    this.sessions.data().sessions.filter((s): s is SshSession => s.type === 'ssh' && s.id !== this.request().session?.id),
  );
  /** Folders flattened with their full path for the <select>. */
  protected readonly folderOptions = computed(() => {
    const { folders } = this.sessions.data();
    const pathOf = (id: string | null): string => {
      const f = folders.find((x) => x.id === id);
      return f ? (f.parentId ? `${pathOf(f.parentId)} / ` : '') + f.name : '';
    };
    return folders.map((f) => ({ id: f.id, path: pathOf(f.id) })).sort((a, b) => a.path.localeCompare(b.path));
  });

  constructor() {
    afterNextRender(() => this.dialog().nativeElement.showModal());
  }

  ngOnInit(): void {
    const { session: s, folderId, type } = this.request();
    if (s?.type === 'ssh') {
      this.form.patchValue({ ...s, keyPath: s.keyPath ?? '', jumpSessionId: s.jumpSessionId ?? '', initialDir: s.initialDir ?? '', folderId: s.folderId ?? '' });
      this.tunnels.set(structuredClone(s.tunnels ?? []));
    } else if (s?.type === 'rdp') {
      const [w, h] = s.screen === 'fullscreen' ? [1600, 900] : s.screen.split('x').map(Number);
      this.form.patchValue({
        ...s,
        domain: s.domain ?? '',
        gateway: s.gateway ?? '',
        viaSshSessionId: s.viaSshSessionId ?? '',
        folderId: s.folderId ?? '',
        fullscreen: s.screen === 'fullscreen',
        width: w,
        height: h,
      });
    } else {
      this.form.patchValue({ folderId: folderId ?? '' });
      if (type === 'rdp') this.setType('rdp');
    }
    if (s) {
      void this.checkSecret(s.id);
      this.form.controls.auth.valueChanges.subscribe(() => void this.checkSecret(s.id));
    }
  }

  /** Only for new sessions: switching type also switches the obvious defaults. */
  protected setType(t: 'ssh' | 'rdp'): void {
    const v = this.form.getRawValue();
    this.form.patchValue({
      type: t,
      port: t === 'rdp' && v.port === 22 ? 3389 : t === 'ssh' && v.port === 3389 ? 22 : v.port,
      icon: t === 'rdp' && v.icon === DEFAULT_SESSION_ICON ? DEFAULT_RDP_ICON : t === 'ssh' && v.icon === DEFAULT_RDP_ICON ? DEFAULT_SESSION_ICON : v.icon,
    });
  }

  private async checkSecret(id: string): Promise<void> {
    const kind = this.secretKind();
    this.hasSecret.set(!!kind && (await estela.invoke('secrets:has', id, kind)));
  }

  protected async browseKey(): Promise<void> {
    const p = await estela.invoke('dialog:openFile', 'Elegir clave privada');
    if (p) this.form.patchValue({ keyPath: p });
  }

  protected setIcon(icon: string | null): void {
    this.form.patchValue({ icon: icon ?? (this.type() === 'rdp' ? DEFAULT_RDP_ICON : DEFAULT_SESSION_ICON) });
    this.pickingIcon.set(false);
  }

  // --- tunnels (SSH) ---

  protected addTunnel(): void {
    this.tunnels.update((t) => [
      ...t,
      { id: crypto.randomUUID(), kind: 'L', bindHost: '127.0.0.1', bindPort: 8080, destHost: 'localhost', destPort: 80, autoStart: false },
    ]);
  }

  protected updateTunnel(i: number, patch: Partial<Tunnel>): void {
    this.tunnels.update((list) => list.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  }

  protected removeTunnel(i: number): void {
    this.tunnels.update((list) => list.filter((_, j) => j !== i));
  }

  protected num(e: Event): number {
    return Number((e.target as HTMLInputElement).value);
  }

  protected val(e: Event): string {
    return (e.target as HTMLInputElement).value.trim();
  }

  // --- save ---

  protected async save(): Promise<void> {
    this.error.set('');
    const v = this.form.getRawValue();
    if (this.form.invalid) return this.error.set('Revisa los campos obligatorios.');
    if (v.type === 'ssh' && v.auth === 'key' && !v.keyPath) return this.error.set('Elige un fichero de clave privada.');
    const kind = this.secretKind();
    if (kind && v.secret && !this.sessions.canStoreSecrets()) {
      return this.error.set('No hay llavero disponible: acepta el aviso o deja la contraseña vacía (se pedirá al conectar).');
    }
    const base = {
      id: this.request().session?.id ?? crypto.randomUUID(),
      name: v.name.trim(),
      folderId: v.folderId || null,
      color: v.color,
      icon: v.icon,
      host: v.host.trim(),
      port: v.port,
      username: v.username.trim(),
    };
    const session: Session =
      v.type === 'ssh'
        ? ({
            ...base,
            type: 'ssh',
            auth: v.auth,
            keyPath: v.auth === 'key' ? v.keyPath : undefined,
            jumpSessionId: v.jumpSessionId || undefined,
            initialDir: v.initialDir.trim() || undefined,
            tunnels: this.tunnels(),
          } satisfies SshSession)
        : ({
            ...base,
            type: 'rdp',
            domain: v.domain.trim() || undefined,
            screen: v.fullscreen ? 'fullscreen' : `${v.width}x${v.height}`,
            multimon: v.multimon,
            clipboard: v.clipboard,
            drives: v.drives,
            gateway: v.gateway.trim() || undefined,
            viaSshSessionId: v.viaSshSessionId || undefined,
          } satisfies RdpSession);
    try {
      await this.sessions.saveSession(session);
      if (kind && v.clearSecret) await estela.invoke('secrets:set', session.id, kind, null);
      else if (kind && v.secret) await estela.invoke('secrets:set', session.id, kind, v.secret);
      this.close();
    } catch (e) {
      this.error.set(cleanError(e));
    }
  }

  protected close(): void {
    this.dialog().nativeElement.close();
    this.closed.emit();
  }
}
