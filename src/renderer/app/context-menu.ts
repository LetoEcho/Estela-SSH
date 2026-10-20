import { Component, input, output } from '@angular/core';
import { COLORS } from './constants';

export interface MenuItem {
  label: string;
  action: () => void;
  danger?: boolean;
}
export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
  /** Optional colour swatch row. */
  pickColor?: (c: string) => void;
}

@Component({
  selector: 'app-context-menu',
  host: { '(document:click)': 'closed.emit()', '(document:keydown.escape)': 'closed.emit()', '(window:blur)': 'closed.emit()' },
  template: `
    <div class="menu" [style.left.px]="state().x" [style.top.px]="state().y" (click)="$event.stopPropagation()">
      @for (item of state().items; track item.label) {
        <button [class.danger-text]="item.danger" (click)="item.action(); closed.emit()">{{ item.label }}</button>
      }
      @if (state().pickColor; as pick) {
        <div class="swatches">
          @for (c of colors; track c) {
            <span class="swatch" [style.background]="c" (click)="pick(c); closed.emit()"></span>
          }
        </div>
      }
    </div>
  `,
  styles: `
    .menu { position: fixed; z-index: 100; background: var(--bg-2); border: 1px solid var(--border); border-radius: 6px;
            padding: 4px; display: flex; flex-direction: column; min-width: 160px; box-shadow: 0 4px 16px rgb(0 0 0 / .4); }
    button { background: none; border: none; text-align: left; padding: 5px 10px; }
    button:hover { background: var(--bg-3); }
    .danger-text { color: var(--danger); }
    .swatches { display: flex; gap: 4px; padding: 5px 10px; }
    .swatch { width: 16px; height: 16px; border-radius: 3px; cursor: pointer; }
  `,
})
export class ContextMenu {
  readonly state = input.required<MenuState>();
  readonly closed = output<void>();
  protected readonly colors = COLORS;
}
