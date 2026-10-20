import { CdkDrag, CdkDragDrop, CdkDropList } from '@angular/cdk/drag-drop';
import { Component, inject, signal } from '@angular/core';
import { ContextMenu, type MenuState } from './context-menu';
import { Icon } from './icon';
import { TabsService, type Tab } from './tabs.service';

@Component({
  selector: 'app-tab-bar',
  imports: [CdkDropList, CdkDrag, ContextMenu, Icon],
  template: `
    <div class="bar" cdkDropList cdkDropListOrientation="horizontal" (cdkDropListDropped)="drop($event)">
      @for (tab of tabs.tabs(); track tab.id) {
        <div class="tab" cdkDrag cdkDragLockAxis="x" [class.active]="tab.id === tabs.activeId()"
             [style.border-top-color]="tab.color()" (mousedown)="tabs.activeId.set(tab.id)"
             (auxclick)="$event.button === 1 && tabs.close(tab)" (contextmenu)="openMenu($event, tab)">
          <span class="dot" [class]="tab.pane.status()" [title]="tab.pane.status()"></span>
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
    @if (menu(); as m) {
      <app-context-menu [state]="m" (closed)="menu.set(null)" />
    }
  `,
  styles: `
    .bar { display: flex; background: var(--bg-2); border-bottom: 1px solid var(--border); overflow-x: auto; min-height: 34px; }
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
  protected readonly tabs = inject(TabsService);
  protected readonly renaming = signal<Tab | null>(null);
  protected readonly menu = signal<MenuState | null>(null);

  protected drop(e: CdkDragDrop<unknown>): void {
    this.tabs.move(e.previousIndex, e.currentIndex);
  }

  protected rename(tab: Tab, value: string): void {
    if (value.trim()) tab.title.set(value.trim());
    this.renaming.set(null);
  }

  protected openMenu(e: MouseEvent, tab: Tab): void {
    e.preventDefault();
    this.menu.set({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Renombrar', action: () => this.renaming.set(tab) },
        { label: 'Duplicar sesión', action: () => this.tabs.duplicate(tab) },
        { label: 'Reconectar', action: () => this.tabs.reconnect(tab.pane) },
        { label: 'Cerrar', action: () => this.tabs.close(tab), danger: true },
      ],
      pickColor: (c) => tab.color.set(c),
    });
  }
}
