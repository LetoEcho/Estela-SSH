import { Component, ElementRef, OnInit, afterNextRender, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import type { SecretKind, SshAuth, SshSession } from '../../shared/session';
import { COLORS, ICONS } from './constants';
import { cleanError, estela } from './estela';
import { Icon } from './icon';
import type { EditRequest } from './session-tree';
import { SessionsService } from './sessions.service';

@Component({
  selector: 'app-session-editor',
  imports: [ReactiveFormsModule, Icon],
  templateUrl: './session-editor.html',
  styles: `
    .icons, .colors { display: flex; gap: 4px; flex-wrap: wrap; }
    .icons button { padding: 2px 6px; }
    .colors span { width: 20px; height: 20px; border-radius: 4px; cursor: pointer; }
    .sel { outline: 2px solid var(--fg); }
    .warn { background: color-mix(in srgb, var(--warn) 20%, transparent); padding: 8px; border-radius: 4px; grid-column: 1 / -1; }
    .error { color: var(--danger); grid-column: 1 / -1; }
    .row { display: flex; gap: 4px; }
    .row input { flex: 1; }
  `,
})
export class SessionEditor implements OnInit {
  readonly request = input.required<EditRequest>();
  readonly closed = output<void>();
  protected readonly sessions = inject(SessionsService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');

  protected readonly colors = COLORS;
  protected readonly icons = ICONS;
  protected readonly form = inject(NonNullableFormBuilder).group({
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
    icon: [ICONS[0]],
    secret: [''],
    clearSecret: [false],
  });
  protected readonly auth = toSignal(this.form.controls.auth.valueChanges, { initialValue: 'password' as SshAuth });
  protected readonly secretKind = computed<SecretKind | null>(() =>
    this.auth() === 'password' ? 'password' : this.auth() === 'key' ? 'passphrase' : null,
  );
  protected readonly hasSecret = signal(false);
  protected readonly error = signal('');

  protected readonly jumpCandidates = computed(() =>
    this.sessions.data().sessions.filter((s) => s.id !== this.request().session?.id),
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
    const { session: s, folderId } = this.request();
    if (s) {
      this.form.patchValue({
        ...s,
        keyPath: s.keyPath ?? '',
        jumpSessionId: s.jumpSessionId ?? '',
        initialDir: s.initialDir ?? '',
        folderId: s.folderId ?? '',
      });
      void this.checkSecret(s.id);
      this.form.controls.auth.valueChanges.subscribe(() => void this.checkSecret(s.id));
    } else {
      this.form.patchValue({ folderId: folderId ?? '' });
    }
  }

  private async checkSecret(id: string): Promise<void> {
    const kind = this.secretKind();
    this.hasSecret.set(!!kind && (await estela.invoke('secrets:has', id, kind)));
  }

  protected async browseKey(): Promise<void> {
    const p = await estela.invoke('dialog:openFile', 'Elegir clave privada');
    if (p) this.form.patchValue({ keyPath: p });
  }

  protected async pickIcon(): Promise<void> {
    try {
      const icon = await estela.invoke('dialog:pickIcon');
      if (icon) this.form.patchValue({ icon });
    } catch (e) {
      this.error.set(cleanError(e));
    }
  }

  protected async save(): Promise<void> {
    this.error.set('');
    const v = this.form.getRawValue();
    if (this.form.invalid) return this.error.set('Revisa los campos obligatorios.');
    if (v.auth === 'key' && !v.keyPath) return this.error.set('Elige un fichero de clave privada.');
    const kind = this.secretKind();
    if (kind && v.secret && !this.sessions.canStoreSecrets()) {
      return this.error.set('No hay llavero disponible: acepta el aviso o deja la contraseña vacía (se pedirá al conectar).');
    }
    const session: SshSession = {
      type: 'ssh',
      id: this.request().session?.id ?? crypto.randomUUID(),
      name: v.name.trim(),
      folderId: v.folderId || null,
      color: v.color,
      icon: v.icon,
      host: v.host.trim(),
      port: v.port,
      username: v.username.trim(),
      auth: v.auth,
      keyPath: v.auth === 'key' ? v.keyPath : undefined,
      jumpSessionId: v.jumpSessionId || undefined,
      initialDir: v.initialDir.trim() || undefined,
    };
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
