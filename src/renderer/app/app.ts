import { Component, computed, inject, signal } from '@angular/core';
import { NoticeService } from './notice.service';
import { PromptDialog } from './prompt-dialog';
import { SessionEditor } from './session-editor';
import { SessionTree, type EditRequest } from './session-tree';
import { SessionsService } from './sessions.service';
import { SftpPanel } from './sftp-panel';
import { SplitView } from './split-view';
import { TabBar } from './tab-bar';
import { TabsService } from './tabs.service';
import { TransfersService } from './transfers.service';

@Component({
  selector: 'app-root',
  imports: [SessionTree, SessionEditor, TabBar, SplitView, SftpPanel, PromptDialog],
  template: `
    @if (keyringWarning(); as backend) {
      <div class="banner">
        ⚠ No hay llavero del sistema disponible (backend «{{ backend }}»). No se guardarán contraseñas salvo que lo aceptes;
        se pedirán al conectar.
        <button (click)="sessions.acceptInsecureSecrets()">Acepto guardarlas sin cifrar</button>
      </div>
    }
    <div class="layout">
      <aside>
        <nav>
          <button [class.on]="sidebar() === 'sessions'" (click)="sidebar.set('sessions')">Sesiones</button>
          <button [class.on]="sidebar() === 'sftp'" (click)="sidebar.set('sftp')">
            SFTP @if (transfers.active()) { <span class="badge">{{ transfers.active() }}</span> }
          </button>
        </nav>
        <app-session-tree [hidden]="sidebar() !== 'sessions'" (edit)="editing.set($event)" />
        <app-sftp-panel [hidden]="sidebar() !== 'sftp'" [visible]="sidebar() === 'sftp'" />
      </aside>
      <main>
        <app-tab-bar />
        <div class="terms">
          @for (tab of tabs.tabs(); track tab.id) {
            <app-split-view [node]="tab.root()" [tab]="tab" [visible]="tab.id === tabs.activeId()" [class.hidden]="tab.id !== tabs.activeId()" />
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
    @if (notice.message(); as m) {
      <div class="toast" (click)="notice.message.set(null)">{{ m }}</div>
    }
  `,
  styles: `
    :host { display: flex; flex-direction: column; height: 100vh; }
    .banner { background: color-mix(in srgb, var(--warn) 25%, var(--bg-2)); padding: 6px 10px; display: flex; gap: 10px; align-items: center; }
    .layout { flex: 1; display: flex; min-height: 0; }
    aside { width: 300px; min-width: 180px; max-width: 60vw; resize: horizontal; overflow: hidden; border-right: 1px solid var(--border);
            background: var(--bg-2); display: flex; flex-direction: column; }
    aside > :not(nav) { flex: 1; min-height: 0; }
    [hidden] { display: none !important; }
    nav { display: flex; border-bottom: 1px solid var(--border); }
    nav button { flex: 1; border: none; border-radius: 0; background: none; padding: 7px; color: var(--fg-dim); }
    nav button.on { color: var(--fg); box-shadow: inset 0 -2px var(--accent); }
    .badge { background: var(--accent); color: #fff; border-radius: 8px; padding: 0 6px; font-size: 11px; }
    .toast { position: fixed; bottom: 16px; right: 16px; max-width: 420px; background: var(--bg-3); border: 1px solid var(--border);
             border-left: 3px solid var(--warn); padding: 10px 14px; border-radius: 6px; z-index: 200; cursor: pointer; }
    main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
    .terms { flex: 1; min-height: 0; position: relative; }
    app-split-view { position: absolute; inset: 0; }
    .hidden { visibility: hidden; }
    .welcome { height: 100%; display: grid; place-items: center; color: var(--fg-dim); }
  `,
})
export class App {
  protected readonly sessions = inject(SessionsService);
  protected readonly tabs = inject(TabsService);
  protected readonly transfers = inject(TransfersService);
  protected readonly notice = inject(NoticeService);
  protected readonly sidebar = signal<'sessions' | 'sftp'>('sessions');
  protected readonly editing = signal<EditRequest | null>(null);
  protected readonly keyringWarning = computed(() => {
    const st = this.sessions.secretStatus();
    return st && !st.secure && !st.acceptedInsecure ? st.backend : null;
  });
}
