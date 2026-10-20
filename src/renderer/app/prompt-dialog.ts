import { Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import type { HostKeyAnswer } from '../../shared/ipc';
import { PromptsService, type PendingPrompt } from './prompts.service';

@Component({
  selector: 'app-prompt-dialog',
  template: `
    <!-- @for with a key recreates the dialog per prompt, so inputs never leak between prompts. -->
    @for (p of head(); track p.promptId) {
      <dialog #dlg (cancel)="$event.preventDefault(); cancel(p)">
        @if (p.kind === 'hostkey') {
          @if (p.oldFingerprint) {
            <h3 class="danger">⚠ ¡La clave del servidor ha cambiado!</h3>
            <p>La identidad de <b>{{ p.host }}:{{ p.port }}</b> no coincide con la guardada.
              Puede ser una reinstalación del servidor… o alguien interceptando la conexión (ataque man-in-the-middle).
              No continúes si no sabes por qué ha cambiado.</p>
            <p>Huella anterior:<br /><code>{{ p.oldFingerprint }}</code></p>
            <p>Huella nueva ({{ p.keyType }}):<br /><code>{{ p.fingerprint }}</code></p>
          } @else {
            <h3>Servidor desconocido</h3>
            <p>Es la primera vez que te conectas a <b>{{ p.host }}:{{ p.port }}</b>. Comprueba la huella:</p>
            <p>{{ p.keyType }}<br /><code>{{ p.fingerprint }}</code></p>
          }
          <div class="actions">
            <button (click)="answerHostKey(p, 'reject')" autofocus>Cancelar</button>
            <button (click)="answerHostKey(p, 'once')">Solo esta vez</button>
            <button [class]="p.oldFingerprint ? 'danger' : 'primary'" (click)="answerHostKey(p, 'save')">
              {{ p.oldFingerprint ? 'Reemplazar la clave guardada' : 'Aceptar y guardar' }}
            </button>
          </div>
        } @else {
          <h3>{{ p.title }}</h3>
          <form (submit)="$event.preventDefault(); prompts.answer(p, { value: pw.value, save: save() })">
            <div class="form">
              <label for="pw">{{ p.label }}</label>
              <input id="pw" #pw type="password" autocomplete="off" autofocus />
            </div>
            @if (p.canSave) {
              <p><label><input type="checkbox" [checked]="save()" (change)="save.set(!save())" /> Recordar</label></p>
            }
            <div class="actions">
              <button type="button" (click)="cancel(p)">Cancelar</button>
              <button class="primary">Aceptar</button>
            </div>
          </form>
        }
      </dialog>
    }
  `,
  styles: `
    .danger { color: var(--danger); }
    p { max-width: 520px; line-height: 1.4; }
  `,
})
export class PromptDialog {
  protected readonly prompts = inject(PromptsService);
  protected readonly head = computed(() => this.prompts.queue().slice(0, 1));
  protected readonly save = signal(false);
  private readonly dlg = viewChild<ElementRef<HTMLDialogElement>>('dlg');

  constructor() {
    effect(() => {
      const el = this.dlg()?.nativeElement;
      if (el && !el.open) {
        this.save.set(false);
        el.showModal();
      }
    });
  }

  protected answerHostKey(p: PendingPrompt, a: HostKeyAnswer): void {
    this.prompts.answer(p, a);
  }

  protected cancel(p: PendingPrompt): void {
    this.prompts.answer(p, p.kind === 'hostkey' ? 'reject' : null);
  }
}
