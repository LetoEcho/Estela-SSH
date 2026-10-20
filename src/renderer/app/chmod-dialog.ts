import { Component, ElementRef, afterNextRender, computed, input, output, signal, viewChild } from '@angular/core';

const WHO = ['Propietario', 'Grupo', 'Otros'];
const WHAT = ['Lectura', 'Escritura', 'Ejecución'];

@Component({
  selector: 'app-chmod-dialog',
  template: `
    <dialog #dlg (cancel)="closed.emit()">
      <h3>Permisos de {{ name() }}</h3>
      <table>
        <tr><th></th>@for (w of what; track w) { <th>{{ w }}</th> }</tr>
        @for (who of whoList; track who; let i = $index) {
          <tr>
            <td>{{ who }}</td>
            @for (w of what; track w; let j = $index) {
              <td><input type="checkbox" [checked]="has(i, j)" (change)="toggle(i, j)" /></td>
            }
          </tr>
        }
      </table>
      <p>Octal: <input [value]="octal()" (change)="setOctal($any($event.target).value)" maxlength="4" style="width: 60px" /></p>
      <div class="actions">
        <button type="button" (click)="closed.emit()">Cancelar</button>
        <button class="primary" (click)="done.emit(mode())">Aplicar</button>
      </div>
    </dialog>
  `,
  styles: `
    td, th { padding: 4px 10px; text-align: center; font-weight: normal; }
    td:first-child { text-align: left; }
  `,
})
export class ChmodDialog {
  readonly name = input.required<string>();
  readonly initial = input.required<number>();
  readonly done = output<number>();
  readonly closed = output<void>();
  protected readonly whoList = WHO;
  protected readonly what = WHAT;
  protected readonly mode = signal(0);
  protected readonly octal = computed(() => this.mode().toString(8).padStart(3, '0'));
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');

  constructor() {
    afterNextRender(() => {
      this.mode.set(this.initial() & 0o7777);
      this.dialog().nativeElement.showModal();
    });
  }

  /** Bit for who (0 = owner) and what (0 = read). */
  private bit = (who: number, what: number) => 1 << ((2 - who) * 3 + (2 - what));
  protected has = (who: number, what: number) => (this.mode() & this.bit(who, what)) !== 0;
  protected toggle(who: number, what: number): void {
    this.mode.update((m) => m ^ this.bit(who, what));
  }
  protected setOctal(v: string): void {
    if (/^[0-7]{3,4}$/.test(v)) this.mode.set(parseInt(v, 8));
  }
}
