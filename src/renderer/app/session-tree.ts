import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, output, signal } from '@angular/core';
import type { Folder, Session } from '../../shared/session';
import { ContextMenu, type MenuState } from './context-menu';
import { cleanError, estela } from './estela';
import { Icon } from './icon';
import { SessionsService } from './sessions.service';
import { TabsService } from './tabs.service';

export interface EditRequest {
  session?: Session;
  folderId: string | null;
}

const DRAG_TYPE = 'application/x-estela-item';

@Component({
  selector: 'app-session-tree',
  imports: [NgTemplateOutlet, ContextMenu, Icon],
  templateUrl: './session-tree.html',
  styles: `
    :host { display: flex; flex-direction: column; height: 100%; }
    .toolbar { display: flex; gap: 4px; padding: 6px; border-bottom: 1px solid var(--border); }
    .toolbar input { flex: 1; min-width: 0; }
    .tree { flex: 1; overflow: auto; padding: 4px 0; }
    .row { display: flex; align-items: center; gap: 6px; padding: 3px 8px; cursor: default; white-space: nowrap; user-select: none; }
    .row:hover { background: var(--bg-3); }
    .row.drop { outline: 1px dashed var(--accent); }
    .chev { width: 10px; color: var(--fg-dim); }
    .swatch { width: 4px; height: 16px; border-radius: 2px; flex: none; }
    .host { color: var(--fg-dim); overflow: hidden; text-overflow: ellipsis; }
    .empty { padding: 12px; color: var(--fg-dim); }
    .row input { padding: 1px 4px; width: 100%; }
  `,
})
export class SessionTree {
  protected readonly sessions = inject(SessionsService);
  private readonly tabs = inject(TabsService);
  readonly edit = output<EditRequest>();

  protected readonly query = signal('');
  protected readonly results = computed(() => this.sessions.search(this.query()));
  protected readonly collapsed = signal(new Set<string>());
  protected readonly renamingFolder = signal<string | null>(null);
  protected readonly dropTarget = signal<string | null | undefined>(undefined);
  protected readonly menu = signal<MenuState | null>(null);

  protected connect(s: Session): void {
    this.tabs.open(s);
  }

  protected toggle(id: string): void {
    this.collapsed.update((set) => {
      const next = new Set(set);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  protected async newFolder(parentId: string | null): Promise<void> {
    const id = crypto.randomUUID();
    await this.sessions.saveFolder({ id, name: 'Nueva carpeta', parentId });
    this.renamingFolder.set(id);
  }

  protected async renameFolder(f: Folder, name: string): Promise<void> {
    this.renamingFolder.set(null);
    if (name.trim() && name.trim() !== f.name) await this.sessions.saveFolder({ ...f, name: name.trim() });
  }

  private async pickFolderIcon(f: Folder): Promise<void> {
    try {
      const icon = await estela.invoke('dialog:pickIcon');
      if (icon) await this.sessions.saveFolder({ ...f, icon });
    } catch (err) {
      alert(cleanError(err));
    }
  }

  // Native HTML5 drag & drop: works across nesting levels without extra wiring.
  protected dragStart(e: DragEvent, kind: 'session' | 'folder', id: string): void {
    e.dataTransfer?.setData(DRAG_TYPE, JSON.stringify({ kind, id }));
  }

  protected dragOver(e: DragEvent, folderId: string | null): void {
    if (!e.dataTransfer?.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.stopPropagation();
    this.dropTarget.set(folderId);
  }

  protected async drop(e: DragEvent, folderId: string | null): Promise<void> {
    e.preventDefault();
    e.stopPropagation();
    this.dropTarget.set(undefined);
    const raw = e.dataTransfer?.getData(DRAG_TYPE);
    if (!raw) return;
    const { kind, id } = JSON.parse(raw) as { kind: 'session' | 'folder'; id: string };
    try {
      if (kind === 'session') {
        const s = this.sessions.find(id);
        if (s && s.folderId !== folderId) await this.sessions.saveSession({ ...s, folderId });
      } else if (id !== folderId) {
        const f = this.sessions.data().folders.find((x) => x.id === id);
        if (f && f.parentId !== folderId) await this.sessions.saveFolder({ ...f, parentId: folderId });
      }
    } catch (err) {
      alert(cleanError(err));
    }
  }

  protected sessionMenu(e: MouseEvent, s: Session): void {
    this.openMenu(e, [
      { label: 'Conectar', action: () => this.connect(s) },
      { label: 'Editar…', action: () => this.edit.emit({ session: s, folderId: s.folderId }) },
      { label: 'Duplicar', action: () => void this.sessions.duplicate(s) },
      {
        label: 'Borrar',
        danger: true,
        action: () => confirm(`¿Borrar la sesión «${s.name}»?`) && void this.sessions.deleteSession(s.id),
      },
    ]);
  }

  protected folderMenu(e: MouseEvent, f: Folder): void {
    this.openMenu(e, [
      { label: 'Nueva sesión aquí…', action: () => this.edit.emit({ folderId: f.id }) },
      { label: 'Nueva subcarpeta', action: () => void this.newFolder(f.id) },
      { label: 'Renombrar', action: () => this.renamingFolder.set(f.id) },
      { label: 'Cambiar icono…', action: () => void this.pickFolderIcon(f) },
      ...(f.icon ? [{ label: 'Quitar icono', action: () => void this.sessions.saveFolder({ ...f, icon: undefined }) }] : []),
      {
        label: 'Borrar carpeta',
        danger: true,
        action: () =>
          confirm(`¿Borrar la carpeta «${f.name}»? Su contenido pasa a la carpeta superior.`) &&
          void this.sessions.deleteFolder(f.id),
      },
    ]);
  }

  protected rootMenu(e: MouseEvent): void {
    this.openMenu(e, [
      { label: 'Nueva sesión…', action: () => this.edit.emit({ folderId: null }) },
      { label: 'Nueva carpeta', action: () => void this.newFolder(null) },
      { label: 'Exportar sesiones…', action: () => void this.sessions.export() },
      { label: 'Importar sesiones…', action: () => void this.importSessions() },
    ]);
  }

  private async importSessions(): Promise<void> {
    try {
      const n = await this.sessions.import();
      if (n !== null) alert(`${n} sesiones importadas`);
    } catch (err) {
      alert(cleanError(err));
    }
  }

  private openMenu(e: MouseEvent, items: MenuState['items']): void {
    e.preventDefault();
    e.stopPropagation();
    this.menu.set({ x: e.clientX, y: e.clientY, items });
  }
}
