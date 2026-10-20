import { Component, computed, inject, signal } from '@angular/core';
import { PromptDialog } from './prompt-dialog';
import { SessionEditor } from './session-editor';
import { SessionTree, type EditRequest } from './session-tree';
import { SessionsService } from './sessions.service';
import { TabBar } from './tab-bar';
import { TabsService } from './tabs.service';
import { TerminalView } from './terminal-view';

@Component({
  selector: 'app-root',
  imports: [SessionTree, SessionEditor, TabBar, TerminalView, PromptDialog],
  template: `
    @if (keyringWarning(); as backend) {
      <div class="banner">
        ⚠ No hay llavero del sistema disponible (backend «{{ backend }}»). No se guardarán contraseñas salvo que lo aceptes;
        se pedirán al conectar.
        <button (click)="sessions.acceptInsecureSecrets()">Acepto guardarlas sin cifrar</button>
      </div>
    }
    <div class="layout">
      <aside><app-session-tree (edit)="editing.set($event)" /></aside>
      <main>
        <app-tab-bar />
        <div class="terms">
          @for (tab of tabs.tabs(); track tab.id) {
            <app-terminal [pane]="tab.pane" [visible]="tab.id === tabs.activeId()" [class.hidden]="tab.id !== tabs.activeId()" />
          } @empty {
            <div class="welcome">Doble clic en una sesión para conectar</div>
          }
        </div>
      </main>
    </div>
    @if (editing(); as req) {
      <app-session-editor [request]="req" (closed)="editing.set(null)" />
    }
    <app-prompt-dialog />
  `,
  styles: `
    :host { display: flex; flex-direction: column; height: 100vh; }
    .banner { background: color-mix(in srgb, var(--warn) 25%, var(--bg-2)); padding: 6px 10px; display: flex; gap: 10px; align-items: center; }
    .layout { flex: 1; display: flex; min-height: 0; }
    aside { width: 260px; min-width: 160px; max-width: 50vw; resize: horizontal; overflow: hidden; border-right: 1px solid var(--border); background: var(--bg-2); }
    main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
    .terms { flex: 1; min-height: 0; position: relative; }
    app-terminal { position: absolute; inset: 0; }
    .hidden { visibility: hidden; }
    .welcome { height: 100%; display: grid; place-items: center; color: var(--fg-dim); }
  `,
})
export class App {
  protected readonly sessions = inject(SessionsService);
  protected readonly tabs = inject(TabsService);
  protected readonly editing = signal<EditRequest | null>(null);
  protected readonly keyringWarning = computed(() => {
    const st = this.sessions.secretStatus();
    return st && !st.secure && !st.acceptedInsecure ? st.backend : null;
  });
}
