import { Component, ElementRef, computed, inject, input } from '@angular/core';
import { Pane, Split, type LayoutNode, type Tab } from './tabs.service';
import { TerminalView } from './terminal-view';

/** Renders a tab's layout tree recursively: panes become terminals, splits become two parts + a divider. */
@Component({
  selector: 'app-split-view',
  imports: [TerminalView],
  template: `
    @if (pane(); as p) {
      <app-terminal [pane]="p" [tab]="tab()" [visible]="visible()" [focused]="tab().panes().length > 1 && tab().activePane() === p" />
    } @else if (split(); as s) {
      <div class="split" [class.column]="s.dir === 'column'">
        <div class="part" [style.flex]="'0 0 ' + s.ratio() * 100 + '%'">
          <app-split-view [node]="s.a" [tab]="tab()" [visible]="visible()" />
        </div>
        <div class="divider" (pointerdown)="resize($event, s)"></div>
        <div class="part rest">
          <app-split-view [node]="s.b" [tab]="tab()" [visible]="visible()" />
        </div>
      </div>
    }
  `,
  styles: `
    :host, .split, .part { display: flex; width: 100%; height: 100%; min-width: 0; min-height: 0; }
    .split.column { flex-direction: column; }
    .rest { flex: 1; }
    app-terminal { flex: 1; min-width: 0; min-height: 0; }
    .divider { flex: 0 0 4px; background: var(--border); cursor: col-resize; }
    .column > .divider { cursor: row-resize; }
    .divider:hover { background: var(--accent); }
  `,
})
export class SplitView {
  readonly node = input.required<LayoutNode>();
  readonly tab = input.required<Tab>();
  readonly visible = input(false);
  protected readonly pane = computed(() => (this.node() instanceof Pane ? (this.node() as Pane) : null));
  protected readonly split = computed(() => (this.node() instanceof Split ? (this.node() as Split) : null));

  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);

  protected resize(e: PointerEvent, s: Split): void {
    e.preventDefault();
    const divider = e.target as HTMLElement;
    divider.setPointerCapture(e.pointerId);
    const box = this.el.nativeElement.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const r = s.dir === 'row' ? (ev.clientX - box.left) / box.width : (ev.clientY - box.top) / box.height;
      s.ratio.set(Math.min(0.9, Math.max(0.1, r)));
    };
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', () => divider.removeEventListener('pointermove', move), { once: true });
  }
}
