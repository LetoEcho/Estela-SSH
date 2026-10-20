import { Component, computed, inject, output } from '@angular/core';
import type { SshSession } from '../../shared/session';
import { cleanError } from './estela';
import { NoticeService } from './notice.service';
import type { EditRequest } from './session-tree';
import { SessionsService } from './sessions.service';
import { TunnelsService, describeTunnel } from './tunnels.service';

/** All tunnels of all sessions, with start/stop. They are edited in each session's editor. */
@Component({
  selector: 'app-tunnels-panel',
  template: `
    @for (s of withTunnels(); track s.id) {
      <div class="session">
        <span>{{ s.name }}</span>
        <button class="icon" title="Editar túneles" (click)="edit.emit({ session: s, folderId: s.folderId })">✎</button>
      </div>
      @for (t of s.tunnels; track t.id) {
        @let st = tunnels.states().get(t.id);
        <div class="tunnel" [title]="st?.error ?? ''">
          <span [class]="'dot ' + dot(st?.state)"></span>
          <span class="kind">{{ t.kind }}</span>
          <span class="desc">{{ describe(t) }}</span>
          @if (t.autoStart) { <span class="auto" title="Arranque automático">auto</span> }
          @if (st?.state === 'running' || st?.state === 'starting') {
            <button class="icon" title="Parar" (click)="tunnels.stop(t.id)">■</button>
          } @else {
            <button class="icon" title="Arrancar" (click)="start(s, t.id)">▶</button>
          }
        </div>
        @if (st?.state === 'error') {
          <div class="err">{{ st?.error }}</div>
        }
      }
    } @empty {
      <div class="empty">
        Ninguna sesión tiene túneles. Añádelos en el editor de una sesión SSH (sección «Túneles»):
        locales (-L), remotos (-R) o dinámicos (-D, proxy SOCKS5).
      </div>
    }
  `,
  styles: `
    :host { display: block; overflow: auto; padding: 4px 0; }
    .session { display: flex; justify-content: space-between; align-items: center; padding: 6px 8px 2px; color: var(--fg-dim); }
    .tunnel { display: flex; gap: 6px; align-items: center; padding: 2px 8px 2px 14px; }
    .kind { font-family: monospace; color: var(--accent); }
    .desc { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: monospace; font-size: 12px; }
    .auto { font-size: 10px; color: var(--fg-dim); border: 1px solid var(--border); border-radius: 3px; padding: 0 3px; }
    .err { color: var(--danger); font-size: 12px; padding: 0 8px 4px 30px; }
    .empty { padding: 12px; color: var(--fg-dim); line-height: 1.4; }
  `,
})
export class TunnelsPanel {
  readonly edit = output<EditRequest>();
  protected readonly tunnels = inject(TunnelsService);
  private readonly sessions = inject(SessionsService);
  private readonly notice = inject(NoticeService);
  protected readonly describe = describeTunnel;
  protected readonly withTunnels = computed(() =>
    this.sessions.data().sessions.filter((s): s is SshSession => s.type === 'ssh' && !!s.tunnels?.length),
  );

  protected dot(state?: string): string {
    return state === 'running' ? 'connected' : state === 'starting' ? 'connecting' : state === 'error' ? 'error' : 'closed';
  }

  protected start(s: SshSession, tunnelId: string): void {
    this.tunnels.start(s.id, tunnelId).catch((e) => this.notice.show(cleanError(e)));
  }
}
