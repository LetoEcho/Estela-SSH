import { Component, ElementRef, afterNextRender, inject, output, signal, viewChild } from '@angular/core';
import type { Settings } from '../../shared/ipc';
import { estela } from './estela';
import { NoticeService } from './notice.service';

@Component({
  selector: 'app-settings-dialog',
  template: `
    <dialog #dlg (cancel)="closed.emit()">
      <h3>Ajustes</h3>
      @if (s(); as v) {
        <div class="form">
          <label>Editar ficheros remotos con</label>
          <div>
            <label><input type="radio" name="ed" [checked]="v.editor === 'internal'" (change)="s.set({ ...v, editor: 'internal' })" /> Editor interno</label><br />
            <label><input type="radio" name="ed" [checked]="v.editor === 'external'" (change)="s.set({ ...v, editor: 'external' })" /> Editor externo</label>
          </div>
          @if (v.editor === 'external') {
            <label for="cmd">Comando</label>
            <div>
              <input id="cmd" [value]="v.externalEditor" (change)="s.set({ ...v, externalEditor: $any($event.target).value })" style="width: 100%" />
              <small>Se le añade la ruta del fichero. Ejemplos: <code>code</code>, <code>gedit</code>, <code>xed</code>. Cada vez que guardes, se sube.</small>
            </div>
          }
        </div>
      }
      <div class="actions">
        <button (click)="closed.emit()">Cancelar</button>
        <button class="primary" (click)="save()">Guardar</button>
      </div>
    </dialog>
  `,
  styles: `small { color: var(--fg-dim); display: block; margin-top: 4px; }`,
})
export class SettingsDialog {
  readonly closed = output<void>();
  protected readonly s = signal<Settings | null>(null);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');
  private readonly notice = inject(NoticeService);

  constructor() {
    afterNextRender(async () => {
      this.s.set(await estela.invoke('settings:get'));
      this.dialog().nativeElement.showModal();
    });
  }

  protected async save(): Promise<void> {
    const v = this.s();
    if (v) await estela.invoke('settings:set', v);
    this.notice.show('Ajustes guardados');
    this.closed.emit();
  }
}
