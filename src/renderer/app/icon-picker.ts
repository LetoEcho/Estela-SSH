import { Component, ElementRef, afterNextRender, input, output, signal, viewChild } from '@angular/core';
import { ICON_GROUPS } from './constants';
import { cleanError, estela } from './estela';
import { Icon } from './icon';

/** Modal icon chooser: built-in emoji by group, or a custom .ico/.png/.svg file. Emits null for "remove". */
@Component({
  selector: 'app-icon-picker',
  imports: [Icon],
  template: `
    <dialog #dlg (cancel)="closed.emit()" (close)="closed.emit()">
      <h3>Elegir icono</h3>
      <div class="groups">
        @for (g of groups; track g.name) {
          <h4>{{ g.name }}</h4>
          <div class="grid">
            @for (i of g.icons; track i) {
              <button type="button" [class.sel]="current() === i" (click)="pick(i)">{{ i }}</button>
            }
          </div>
        }
      </div>
      @if (error()) {
        <p class="error">{{ error() }}</p>
      }
      <div class="actions">
        @if (current().startsWith('data:')) {
          <span class="custom">Actual: <app-icon [icon]="current()" /></span>
        }
        <button type="button" (click)="fromFile()">Desde archivo… (.ico, .png, .svg)</button>
        @if (removable()) {
          <button type="button" (click)="picked.emit(null)">Quitar</button>
        }
        <button type="button" (click)="closed.emit()">Cancelar</button>
      </div>
    </dialog>
  `,
  styles: `
    dialog { width: 560px; }
    .groups { max-height: 55vh; overflow: auto; }
    h4 { margin: 10px 0 4px; color: var(--fg-dim); font-weight: normal; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, 40px); gap: 4px; }
    .grid button { font-size: 20px; height: 40px; padding: 0; }
    .sel { outline: 2px solid var(--accent); }
    .actions { align-items: center; }
    .custom { margin-right: auto; display: flex; gap: 6px; align-items: center; }
    .error { color: var(--danger); }
  `,
})
export class IconPicker {
  readonly current = input('');
  readonly removable = input(false);
  readonly picked = output<string | null>();
  readonly closed = output<void>();
  protected readonly groups = ICON_GROUPS;
  protected readonly error = signal('');
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');

  constructor() {
    afterNextRender(() => this.dialog().nativeElement.showModal());
  }

  protected pick(icon: string): void {
    this.picked.emit(icon);
  }

  protected async fromFile(): Promise<void> {
    try {
      const icon = await estela.invoke('dialog:pickIcon');
      if (icon) this.picked.emit(icon);
    } catch (e) {
      this.error.set(cleanError(e));
    }
  }
}
