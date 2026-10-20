import { Component, ElementRef, afterNextRender, inject, output, signal, viewChild } from '@angular/core';
import type { Settings } from '../../shared/ipc';
import { DEFAULT_SETTINGS } from '../../shared/settings';
import { estela } from './estela';
import { NoticeService } from './notice.service';
import { SettingsService } from './settings.service';

@Component({
  selector: 'app-settings-dialog',
  template: `
    <dialog #dlg (cancel)="closed.emit()">
      <h3>Ajustes</h3>
      @let v = s();
      <div class="form">
        <h4>Apariencia</h4>
        <label for="theme">Tema</label>
        <select id="theme" [value]="v.theme" (change)="set({ theme: $any(val($event)) })">
          <option value="system">Como el sistema</option>
          <option value="dark">Oscuro</option>
          <option value="light">Claro</option>
        </select>
        <label for="font">Fuente</label>
        <input id="font" [value]="v.fontFamily" (change)="set({ fontFamily: val($event) })" />
        <label for="size">Tamaño</label>
        <input id="size" type="number" min="8" max="32" [value]="v.fontSize" (change)="set({ fontSize: num($event) })" />

        <h4>Terminal</h4>
        <label for="sb">Líneas de historial</label>
        <input id="sb" type="number" min="1000" max="200000" step="1000" [value]="v.scrollback" (change)="set({ scrollback: num($event) })" />
        <span></span>
        <div class="checks">
          <label><input type="checkbox" [checked]="v.copyOnSelect" (change)="set({ copyOnSelect: !v.copyOnSelect })" /> Copiar al seleccionar</label>
          <label><input type="checkbox" [checked]="v.rightClickPaste" (change)="set({ rightClickPaste: !v.rightClickPaste })" /> Pegar con clic derecho</label>
        </div>

        <h4>Conexión SSH</h4>
        <label for="ka">Keepalive (s)</label>
        <div>
          <input id="ka" type="number" min="0" max="600" [value]="v.keepaliveSec" (change)="set({ keepaliveSec: num($event) })" style="width: 90px" />
          <small>0 = desactivado. Evita que firewalls y NAT corten las sesiones inactivas.</small>
        </div>
        <span></span>
        <label><input type="checkbox" [checked]="v.autoReconnect" (change)="set({ autoReconnect: !v.autoReconnect })" /> Reconectar automáticamente si se cae la red</label>

        <h4>Logs de sesión</h4>
        <label for="logs">Carpeta</label>
        <div class="row">
          <input id="logs" [value]="v.logDir" [placeholder]="defaultLogDir()" (change)="set({ logDir: val($event) })" />
          <button type="button" (click)="pickLogDir()">…</button>
        </div>
        <span></span>
        <small>Activa el log en cada sesión (editor de sesión → «Guardar log»).</small>

        <h4>Editor de ficheros remotos</h4>
        <span></span>
        <div>
          <label><input type="radio" name="ed" [checked]="v.editor === 'internal'" (change)="set({ editor: 'internal' })" /> Editor interno</label>
          <label><input type="radio" name="ed" [checked]="v.editor === 'external'" (change)="set({ editor: 'external' })" /> Editor externo</label>
        </div>
        @if (v.editor === 'external') {
          <label for="cmd">Comando</label>
          <div>
            <input id="cmd" [value]="v.externalEditor" (change)="set({ externalEditor: val($event) })" style="width: 100%" />
            <small>Se le añade la ruta del fichero. Ejemplos: <code>code</code>, <code>gedit</code>, <code>notepad++</code>. Cada vez que guardes, se sube.</small>
          </div>
        }
      </div>
      <div class="actions">
        <small class="version">Estela SSH {{ version() }}</small>
        <button (click)="s.set(defaults)">Valores por defecto</button>
        <button (click)="closed.emit()">Cancelar</button>
        <button class="primary" (click)="save()">Guardar</button>
      </div>
    </dialog>
  `,
  styles: `
    dialog { width: 600px; }
    .form { max-height: 70vh; overflow: auto; }
    h4 { grid-column: 1 / -1; margin: 10px 0 0; color: var(--fg-dim); font-weight: normal; border-top: 1px solid var(--border); padding-top: 8px; }
    h4:first-child { border-top: none; margin-top: 0; }
    small { color: var(--fg-dim); display: block; margin-top: 4px; }
    .checks { display: flex; gap: 14px; flex-wrap: wrap; }
    .row { display: flex; gap: 4px; }
    .row input { flex: 1; }
    .version { margin-right: auto; align-self: center; }
  `,
})
export class SettingsDialog {
  readonly closed = output<void>();
  private readonly settings = inject(SettingsService);
  private readonly notice = inject(NoticeService);
  protected readonly s = signal<Settings>(this.settings.value());
  protected readonly defaults = DEFAULT_SETTINGS;
  protected readonly version = signal('');
  protected readonly defaultLogDir = signal('');
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');

  constructor() {
    afterNextRender(() => {
      this.dialog().nativeElement.showModal();
      void estela.invoke('app:info').then((i) => (this.version.set(i.version), this.defaultLogDir.set(i.defaultLogDir)));
    });
  }

  protected set(patch: Partial<Settings>): void {
    this.s.update((v) => ({ ...v, ...patch }));
  }

  protected val(e: Event): string {
    return (e.target as HTMLInputElement).value.trim();
  }

  protected num(e: Event): number {
    return Number((e.target as HTMLInputElement).value);
  }

  protected async pickLogDir(): Promise<void> {
    const dir = await estela.invoke('dialog:openDir', 'Carpeta para los logs de sesión');
    if (dir) this.set({ logDir: dir });
  }

  protected async save(): Promise<void> {
    await this.settings.save(this.s());
    this.notice.show('Ajustes guardados');
    this.closed.emit();
  }
}
