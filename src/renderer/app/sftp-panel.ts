import { Component, OnDestroy, computed, effect, inject, input, signal, untracked } from '@angular/core';
import type { SftpEntry, TransferDirection } from '../../shared/ipc';
import { ChmodDialog } from './chmod-dialog';
import { ContextMenu, type MenuItem, type MenuState } from './context-menu';
import { cleanError, estela } from './estela';
import { formatMode, formatSize } from './format';
import { InputDialog } from './input-dialog';
import { NoticeService } from './notice.service';
import { TabsService, type Pane } from './tabs.service';
import { TransfersService } from './transfers.service';

const rjoin = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`);
const rparent = (p: string) => p.replace(/\/[^/]+\/?$/, '') || '/';
const CWD_POLL_MS = 2000;

type Dialog =
  | { kind: 'mkdir' }
  | { kind: 'rename'; entry: SftpEntry }
  | { kind: 'chmod'; entry: SftpEntry };

/**
 * Remote file browser for the focused pane. By default it follows the terminal's cwd
 * (OSC 7, or /proc polling when the shell has no hook); browsing by hand "unpins" it.
 */
@Component({
  selector: 'app-sftp-panel',
  imports: [ContextMenu, InputDialog, ChmodDialog],
  templateUrl: './sftp-panel.html',
  styleUrl: './sftp-panel.css',
})
export class SftpPanel implements OnDestroy {
  readonly visible = input(false);
  protected readonly tabs = inject(TabsService);
  protected readonly transfers = inject(TransfersService);
  private readonly notice = inject(NoticeService);

  protected readonly pane = this.tabs.activePane;
  protected readonly connected = computed(() => this.pane()?.status() === 'connected');
  protected readonly path = computed(() => this.pane()?.sftpPath() ?? null);
  protected readonly entries = signal<SftpEntry[]>([]);
  protected readonly showHidden = signal(false);
  protected readonly visibleEntries = computed(() =>
    this.showHidden() ? this.entries() : this.entries().filter((e) => !e.name.startsWith('.')),
  );
  protected readonly selected = signal(new Set<string>());
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly menu = signal<MenuState | null>(null);
  protected readonly dialog = signal<Dialog | null>(null);
  protected readonly dropping = signal(false);
  /** The shell reports nothing (no hook, no pid): offer to retry the hook. */
  protected readonly trackingUnavailable = computed(() => {
    const h = this.pane()?.hook();
    return !!h && !h.installed && !h.pid;
  });
  protected readonly formatSize = formatSize;
  protected readonly formatMode = formatMode;

  private loadToken = 0;
  private lastClicked: string | null = null;
  private poll?: ReturnType<typeof setInterval>;

  constructor() {
    // Following: the terminal's cwd drives the panel.
    effect(() => {
      const pane = this.pane();
      const cwd = pane?.cwd();
      if (pane && cwd && pane.follow()) pane.sftpPath.set(cwd);
    });
    // First connection of a pane without cwd info yet: start at the remote home.
    effect(() => {
      const pane = this.pane();
      if (!pane || pane.isLocal || !this.visible() || !this.connected() || pane.sftpPath()) return;
      const hook = pane.hook();
      if (hook === null && pane.follow()) return; // the hook is about to report the cwd
      void estela.invoke('sftp:home', pane.connId!).then((home) => {
        if (!pane.sftpPath()) pane.sftpPath.set(home);
      });
    });
    // Load whenever pane, path or connection changes.
    effect(() => {
      const pane = this.pane();
      const path = this.path();
      if (this.visible() && pane && !pane.isLocal && path && this.connected()) untracked(() => void this.load(pane, path));
      else untracked(() => this.entries.set([]));
    });
    // Shells without OSC 7 but with a known pid: poll /proc while following.
    effect(() => {
      clearInterval(this.poll);
      const pane = this.pane();
      const hook = pane?.hook();
      if (!pane || !this.visible() || !this.connected() || !pane.follow() || !hook || hook.installed || !hook.pid) return;
      const tick = () =>
        void estela.invoke('conn:cwd', pane.connId!).then((cwd) => cwd && pane.cwd.set(cwd), () => {});
      tick();
      this.poll = setInterval(tick, CWD_POLL_MS);
    });
    // Refresh when an upload lands in the directory shown.
    effect(() => {
      const t = this.transfers.lastFinished();
      const pane = untracked(() => this.pane());
      if (t && pane && t.connId === pane.connId && t.direction === 'up' && rparent(t.target) === untracked(() => this.path())) {
        untracked(() => this.refresh());
      }
    });
  }

  ngOnDestroy(): void {
    clearInterval(this.poll);
  }

  private async load(pane: Pane, path: string): Promise<void> {
    const token = ++this.loadToken;
    this.loading.set(true);
    try {
      const list = await estela.invoke('sftp:list', pane.connId!, path);
      if (token !== this.loadToken) return; // a newer navigation won
      this.entries.set(list);
      this.error.set(null);
      this.selected.set(new Set());
    } catch (e) {
      if (token === this.loadToken) {
        this.entries.set([]);
        this.error.set(cleanError(e));
      }
    } finally {
      if (token === this.loadToken) this.loading.set(false);
    }
  }

  protected refresh(): void {
    const pane = this.pane();
    const path = this.path();
    if (pane && path && this.connected()) void this.load(pane, path);
  }

  /** Manual navigation unpins the panel from the terminal. */
  protected navigate(path: string): void {
    const pane = this.pane();
    if (!pane) return;
    pane.follow.set(false);
    pane.sftpPath.set(path.trim() || '/');
  }

  protected toggleFollow(): void {
    const pane = this.pane();
    if (!pane) return;
    pane.follow.update((f) => !f);
    const cwd = pane.cwd();
    if (pane.follow() && cwd) pane.sftpPath.set(cwd);
  }

  protected goToTerminal(): void {
    const pane = this.pane();
    if (!pane) return;
    pane.follow.set(true);
    const cwd = pane.cwd();
    if (cwd) pane.sftpPath.set(cwd);
    else this.notice.show('La terminal todavía no ha informado de su ruta.');
  }

  protected retryHook(): void {
    const pane = this.pane();
    if (!pane?.connId) return;
    if (!confirm('Se escribirá una línea en la terminal para activar el seguimiento. Asegúrate de que la línea de comandos está vacía.')) return;
    pane.hook.set(null);
    estela.send('conn:retryHook', pane.connId);
  }

  // --- selection -------------------------------------------------------------------------

  protected click(e: MouseEvent, entry: SftpEntry): void {
    const sel = new Set(e.ctrlKey ? this.selected() : []);
    if (e.shiftKey && this.lastClicked) {
      const names = this.visibleEntries().map((x) => x.path);
      const [a, b] = [names.indexOf(this.lastClicked), names.indexOf(entry.path)].sort((x, y) => x - y);
      for (const p of names.slice(a, b + 1)) sel.add(p);
    } else if (e.ctrlKey && sel.has(entry.path)) {
      sel.delete(entry.path);
    } else {
      sel.add(entry.path);
      this.lastClicked = entry.path;
    }
    this.selected.set(sel);
  }

  private selection(entry?: SftpEntry): SftpEntry[] {
    const sel = this.selected();
    if (entry && !sel.has(entry.path)) return [entry];
    return this.entries().filter((e) => sel.has(e.path));
  }

  protected open(entry: SftpEntry): void {
    if (entry.isDir) this.navigate(entry.path);
    else void this.download([entry], null);
  }

  // --- operations ------------------------------------------------------------------------

  private async run(op: () => Promise<unknown>, refresh = true): Promise<void> {
    try {
      await op();
      if (refresh) this.refresh();
    } catch (e) {
      this.notice.show(cleanError(e));
    }
  }

  /** Asks before overwriting; returns false if the user backs out. */
  private async confirmConflicts(direction: TransferDirection, sources: string[], target: string | null): Promise<boolean> {
    const conflicts = await estela.invoke('transfer:conflicts', this.pane()!.connId!, direction, sources, target ?? '');
    if (!conflicts.length) return true;
    const list = conflicts.slice(0, 10).join('\n') + (conflicts.length > 10 ? `\n… y ${conflicts.length - 10} más` : '');
    return confirm(`Ya existen y se sobrescribirán:\n\n${list}\n\n¿Continuar?`);
  }

  protected async download(entries: SftpEntry[], localDir: string | null): Promise<void> {
    const paths = entries.map((e) => e.path);
    await this.run(async () => {
      if (await this.confirmConflicts('down', paths, localDir)) {
        await estela.invoke('transfer:download', this.pane()!.connId!, paths, localDir);
      }
    }, false);
  }

  protected async downloadTo(entries: SftpEntry[]): Promise<void> {
    const dir = await estela.invoke('dialog:openDir', 'Descargar en…');
    if (dir) await this.download(entries, dir);
  }

  protected async upload(localPaths: string[], remoteDir = this.path()): Promise<void> {
    if (!localPaths.length || !remoteDir) return;
    await this.run(async () => {
      if (await this.confirmConflicts('up', localPaths, remoteDir)) {
        await estela.invoke('transfer:upload', this.pane()!.connId!, localPaths, remoteDir);
      }
    }, false);
  }

  protected async pickUpload(): Promise<void> {
    await this.upload(await estela.invoke('dialog:openFiles', 'Subir ficheros'));
  }

  protected delete(entries: SftpEntry[]): void {
    const names = entries.map((e) => e.name + (e.isDir && e.type === 'dir' ? '/' : '')).join('\n');
    if (!confirm(`¿Borrar definitivamente (las carpetas, con todo su contenido)?\n\n${names}`)) return;
    void this.run(() => estela.invoke('sftp:delete', this.pane()!.connId!, entries.map((e) => e.path)));
  }

  protected dialogDone(d: Dialog, value: string | number): void {
    this.dialog.set(null);
    const conn = this.pane()!.connId!;
    if (d.kind === 'mkdir') void this.run(() => estela.invoke('sftp:mkdir', conn, rjoin(this.path()!, String(value))));
    if (d.kind === 'rename') void this.run(() => estela.invoke('sftp:rename', conn, d.entry.path, rjoin(rparent(d.entry.path), String(value))));
    if (d.kind === 'chmod') void this.run(() => estela.invoke('sftp:chmod', conn, d.entry.path, Number(value)));
  }

  protected async edit(entry: SftpEntry): Promise<void> {
    await this.run(() => estela.invoke('editor:open', this.pane()!.connId!, entry.path), false);
  }

  protected copyPath(p: string): void {
    void navigator.clipboard.writeText(p);
  }

  // --- menus ------------------------------------------------------------------------------

  protected entryMenu(e: MouseEvent, entry: SftpEntry): void {
    e.preventDefault();
    e.stopPropagation();
    if (!this.selected().has(entry.path)) this.selected.set(new Set([entry.path]));
    const items = this.selection(entry);
    const single = items.length === 1;
    const menu: MenuItem[] = [
      ...(single && entry.isDir ? [{ label: 'Abrir', action: () => this.navigate(entry.path) }] : []),
      ...(single && !entry.isDir ? [{ label: 'Editar', action: () => void this.edit(entry) }] : []),
      { label: 'Descargar', action: () => void this.download(items, null) },
      { label: 'Descargar en…', action: () => void this.downloadTo(items) },
      ...(single
        ? [
            { label: 'Renombrar…', action: () => this.dialog.set({ kind: 'rename', entry }) },
            { label: 'Permisos…', action: () => this.dialog.set({ kind: 'chmod', entry }) },
            { label: 'Copiar ruta', action: () => this.copyPath(entry.path) },
          ]
        : []),
      { label: single ? 'Borrar' : `Borrar ${items.length} elementos`, danger: true, action: () => this.delete(items) },
    ];
    this.menu.set({ x: e.clientX, y: e.clientY, items: menu });
  }

  protected backgroundMenu(e: MouseEvent): void {
    e.preventDefault();
    if (!this.connected() || !this.path()) return;
    this.menu.set({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Nueva carpeta…', action: () => this.dialog.set({ kind: 'mkdir' }) },
        { label: 'Subir ficheros…', action: () => void this.pickUpload() },
        { label: 'Refrescar', action: () => this.refresh() },
        { label: 'Copiar ruta actual', action: () => this.copyPath(this.path()!) },
      ],
    });
  }

  // --- drag & drop with the OS file manager -----------------------------------------------

  protected dragStart(e: DragEvent, entry: SftpEntry): void {
    // Electron's native drag replaces the HTML one; main downloads first, then starts it.
    e.preventDefault();
    if (!this.selected().has(entry.path)) this.selected.set(new Set([entry.path]));
    estela.send('sftp:dragOut', this.pane()!.connId!, this.selection(entry).map((x) => x.path));
  }

  protected dragOver(e: DragEvent): void {
    if (!this.connected() || !e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    this.dropping.set(true);
  }

  protected drop(e: DragEvent, target?: SftpEntry): void {
    e.preventDefault();
    e.stopPropagation();
    this.dropping.set(false);
    const files = [...(e.dataTransfer?.files ?? [])].map((f) => estela.pathForFile(f)).filter(Boolean);
    void this.upload(files, target?.isDir ? target.path : this.path());
  }

  protected parent(p: string): string {
    return rparent(p);
  }
}
