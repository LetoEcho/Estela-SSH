import { Injectable, computed, inject, signal } from '@angular/core';
import { TabsService, type Pane } from './tabs.service';

/** Multi-exec: typing in one selected pane is sent to every selected pane (any tab). */
@Injectable({ providedIn: 'root' })
export class MultiExecService {
  private readonly tabs = inject(TabsService);
  readonly enabled = signal(false);
  readonly selected = signal(new Set<string>());
  readonly targets = computed(() => this.tabs.allPanes().filter((p) => this.selected().has(p.id) && p.status() === 'connected'));

  toggle(): void {
    if (!this.enabled()) this.selectAll();
    this.enabled.update((e) => !e);
  }

  isSelected(pane: Pane): boolean {
    return this.enabled() && this.selected().has(pane.id);
  }

  toggleSelected(pane: Pane): void {
    this.selected.update((s) => {
      const n = new Set(s);
      if (!n.delete(pane.id)) n.add(pane.id);
      return n;
    });
  }

  selectAll(): void {
    this.selected.set(new Set(this.tabs.allPanes().map((p) => p.id)));
  }

  selectNone(): void {
    this.selected.set(new Set());
  }

  /** Returns true if the input was broadcast (the caller must not send it again). */
  broadcast(from: Pane, data: string): boolean {
    if (!this.isSelected(from)) return false;
    for (const p of this.targets()) this.tabs.write(p, data);
    return true;
  }
}
