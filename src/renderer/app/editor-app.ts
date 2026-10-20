import { Component, ElementRef, afterNextRender, effect, inject, signal, viewChild } from '@angular/core';
import { cleanError, estela } from './estela';
import { SettingsService } from './settings.service';

type Monaco = typeof import('monaco-editor');

/** Root component of the editor window (opened with #editor=<id>): Monaco + save back over SFTP. */
@Component({
  selector: 'app-root',
  template: `
    <header>
      <span class="name">{{ dirty() ? '● ' : '' }}{{ name() }}</span>
      <span class="path">{{ path() }}</span>
      <span class="status" [class.error]="!!error()">{{ error() || status() }}</span>
      <button class="primary" [disabled]="!dirty() || saving()" (click)="save()">Guardar (Ctrl+S)</button>
    </header>
    <div #host class="host"></div>
  `,
  styles: `
    :host { display: flex; flex-direction: column; height: 100vh; }
    header { display: flex; gap: 12px; align-items: center; padding: 6px 10px; background: var(--bg-2); border-bottom: 1px solid var(--border); }
    .name { font-weight: 600; }
    .path { color: var(--fg-dim); font-family: monospace; font-size: 12px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .status { color: var(--fg-dim); }
    .status.error { color: var(--danger); }
    .host { flex: 1; min-height: 0; }
  `,
})
export class EditorApp {
  private readonly id = decodeURIComponent(location.hash.replace(/^#editor=/, ''));
  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  protected readonly name = signal('');
  protected readonly path = signal('');
  protected readonly dirty = signal(false);
  protected readonly saving = signal(false);
  protected readonly status = signal('Cargando…');
  protected readonly error = signal('');
  private readonly settings = inject(SettingsService);
  private editor?: import('monaco-editor').editor.IStandaloneCodeEditor;
  private monaco?: Monaco;
  private savedVersion = 0;

  constructor() {
    afterNextRender(() => void this.init());
    effect(() => {
      const theme = this.settings.theme() === 'dark' ? 'vs-dark' : 'vs';
      const fontSize = this.settings.value().fontSize;
      this.monaco?.editor.setTheme(theme);
      this.editor?.updateOptions({ fontSize });
    });
  }

  private async init(): Promise<void> {
    // Angular does not inject CSS imported by lazy chunks; Monaco's styles are a separate bundle.
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'monaco.css';
    document.head.appendChild(css);
    try {
      const [file, monaco] = await Promise.all([estela.invoke('editor:load', this.id), import('monaco-editor')]);
      this.monaco = monaco;
      this.name.set(file.name);
      this.path.set(file.path);
      document.title = `${file.name} — Estela SSH`;
      const editor = (this.editor = monaco.editor.create(this.host().nativeElement, {
        value: file.content,
        language: languageFor(monaco, file.name),
        theme: this.settings.theme() === 'dark' ? 'vs-dark' : 'vs',
        automaticLayout: true,
        fontSize: this.settings.value().fontSize,
        minimap: { enabled: false },
      }));
      this.savedVersion = editor.getModel()!.getAlternativeVersionId();
      editor.onDidChangeModelContent(() => this.dirty.set(editor.getModel()!.getAlternativeVersionId() !== this.savedVersion));
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void this.save());
      editor.focus();
      this.status.set('');
    } catch (e) {
      this.error.set(cleanError(e));
    }
  }

  protected async save(): Promise<void> {
    const model = this.editor?.getModel();
    if (!model || this.saving()) return;
    this.saving.set(true);
    const version = model.getAlternativeVersionId();
    try {
      await estela.invoke('editor:save', this.id, model.getValue());
      this.savedVersion = version;
      this.dirty.set(model.getAlternativeVersionId() !== version);
      this.error.set('');
      this.status.set(`Guardado ${new Date().toLocaleTimeString()}`);
    } catch (e) {
      this.error.set(cleanError(e));
    } finally {
      this.saving.set(false);
    }
  }
}

/** Monaco language id from the file name (extension or exact name such as "Dockerfile"). */
function languageFor(monaco: Monaco, name: string): string {
  const lower = name.toLowerCase();
  const lang = monaco.languages
    .getLanguages()
    .find((l) => l.filenames?.some((f) => f.toLowerCase() === lower) || l.extensions?.some((e) => lower.endsWith(e.toLowerCase())));
  return lang?.id ?? 'plaintext';
}
