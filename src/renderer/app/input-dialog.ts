import { Component, ElementRef, afterNextRender, input, output, viewChild } from '@angular/core';

/** Small modal text prompt (Electron does not implement window.prompt). */
@Component({
  selector: 'app-input-dialog',
  template: `
    <dialog #dlg (cancel)="closed.emit()">
      <form (submit)="$event.preventDefault(); value.value.trim() && done.emit(value.value.trim())">
        <h3>{{ title() }}</h3>
        <input #value [value]="initial()" style="width: 100%" />
        <div class="actions">
          <button type="button" (click)="closed.emit()">Cancelar</button>
          <button class="primary">Aceptar</button>
        </div>
      </form>
    </dialog>
  `,
})
export class InputDialog {
  readonly title = input.required<string>();
  readonly initial = input('');
  readonly done = output<string>();
  readonly closed = output<void>();
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');
  private readonly field = viewChild.required<ElementRef<HTMLInputElement>>('value');

  constructor() {
    afterNextRender(() => {
      this.dialog().nativeElement.showModal();
      const f = this.field().nativeElement;
      // Select the name without its extension, like file managers do.
      const dot = f.value.lastIndexOf('.');
      f.setSelectionRange(0, dot > 0 ? dot : f.value.length);
    });
  }
}
