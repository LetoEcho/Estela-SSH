import { CdkDrag, CdkDragDrop, CdkDropList } from '@angular/cdk/drag-drop';
import { Component, inject, output, signal } from '@angular/core';
import { ContextMenu, type MenuItem, type MenuState } from './context-menu';
import { estela } from './estela';
import { Icon } from './icon';
import { MultiExecService } from './multi-exec.service';
import { Tab, TabsService, type AnyTab } from './tabs.service';

@Component({
  selector: 'app-tab-bar',
  imports: [CdkDropList, CdkDrag, ContextMenu, Icon],
  template: `
    <div class="bar">
      <div class="tabs" cdkDropList cdkDropListOrientation="horizontal" (cdkDropListDropped)="drop($event)">
        @for (tab of tabs.tabs(); track tab.id) {
          <div class="tab" cdkDrag cdkDragLockAxis="x" [class.active]="tab.id === tabs.activeId()"
               [style.border-top-color]="tab.color()" (mousedown)="tabs.activeId.set(tab.id)"
               (auxclick)="$event.button === 1 && tabs.close(tab)" (contextmenu)="openMenu($event, tab)">
            <span [class]="'dot ' + tab.status()" [title]="tab.status()"></span>
            <app-icon [icon]="tab.icon" />
            @if (renaming() === tab) {
              <input #r [value]="tab.title()" (keydown.enter)="rename(tab, r.value)" (keydown.escape)="renaming.set(null)"
                     (blur)="rename(tab, r.value)" (mousedown)="$event.stopPropagation()" />
            } @else {
              <span class="title" (dblclick)="renaming.set(tab)">{{ tab.title() }}</span>
            }
            <button class="icon" title="Cerrar" (mousedown)="$event.stopPropagation()" (click)="tabs.close(tab)">×</button>
          </div>
        }
      </div>
      <div class="tools">
        <button class="icon" title="Terminal local" (click)="localMenu($event)">💻＋</button>
        <button class="icon" [class.on]="multi.enabled()" title="Multi-exec: escribir en varios paneles a la vez" (click)="multi.toggle()">⌨</button>
        <button class="icon" title="Ajustes" (click)="settings.emit()">⚙</button>
      </div>
    </div>
    @if (menu(); as m) {
      <app-context-menu [state]="m" (closed)="menu.set(null)" />
    }
  `,
  styles: `
    .bar { display: flex; background: var(--bg-2); border-bottom: 1px solid var(--border); min-height: 34px; }
    .tabs { display: flex; flex: 1; overflow-x: auto; }
    .tools { display: flex; align-items: center; gap: 2px; padding: 0 6px; border-left: 1px solid var(--border); }
    .tools .on { background: color-mix(in srgb, var(--warn) 40%, transparent); border-radius: 4px; }
    .tab { display: flex; align-items: center; gap: 6px; padding: 0 4px 0 10px; height: 34px; border-top: 3px solid transparent;
           border-right: 1px solid var(--border); cursor: default; white-space: nowrap; background: var(--bg-2); user-select: none; }
    .tab.active { background: var(--bg); }
    .title { max-width: 200px; overflow: hidden; text-overflow: ellipsis; }
    input { width: 140px; padding: 1px 4px; }
    .cdk-drag-preview { opacity: .8; }
    .cdk-drag-placeholder { opacity: .3; }
  `,
})
export class TabBar {
  readonly settings = output<void>();
  protected readonly tabs = inject(TabsService);
  protected readonly multi = inject(MultiExecService);
  protected readonly renaming = signal<AnyTab | null>(null);
  protected readonly menu = signal<MenuState | null>(null);

  protected drop(e: CdkDragDrop<unknown>): void {
    this.tabs.move(e.previousIndex, e.currentIndex);
  }

  protected rename(tab: AnyTab, value: string): void {
    if (value.trim()) tab.title.set(value.trim());
    this.renaming.set(null);
  }

  protected async localMenu(e: MouseEvent): Promise<void> {
    e.stopPropagation();
    const shells = await estela.invoke('local:shells');
    this.menu.set({
      x: e.clientX - 160,
      y: e.clientY + 10,
      items: shells.map((s, i) => ({ label: `${s.name}${i === 0 ? ' (predeterminada)' : ''} — ${s.path}`, action: () => this.tabs.openLocal(s) })),
    });
  }

  protected openMenu(e: MouseEvent, tab: AnyTab): void {
    e.preventDefault();
    const items: MenuItem[] = [
      { label: 'Renombrar', action: () => this.renaming.set(tab) },
      { label: 'Duplicar sesión', action: () => this.tabs.duplicate(tab) },
    ];
    if (tab instanceof Tab) {
      items.push(
        { label: 'Dividir a la derecha (Ctrl+Shift+E)', action: () => (this.tabs.activeId.set(tab.id), this.tabs.split('row')) },
        { label: 'Dividir abajo (Ctrl+Shift+O)', action: () => (this.tabs.activeId.set(tab.id), this.tabs.split('column')) },
        { label: 'Reconectar panel activo', action: () => this.tabs.reconnect(tab.activePane()) },
        ...(tab.panes().length > 1
          ? [{ label: 'Cerrar panel activo (Ctrl+Shift+W)', action: () => this.tabs.closePane(tab, tab.activePane()) }]
          : []),
      );
    } else {
      items.push({ label: 'Reconectar', action: () => void this.tabs.launchRdp(tab) });
    }
    items.push({ label: 'Cerrar pestaña', action: () => this.tabs.close(tab), danger: true });
    this.menu.set({ x: e.clientX, y: e.clientY, items, pickColor: (c) => tab.color.set(c) });
  }
}
