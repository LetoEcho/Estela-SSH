import { Component, inject, input } from '@angular/core';
import { estela } from './estela';
import { Icon } from './icon';
import { NoticeService } from './notice.service';
import { TabsService, type RdpTab } from './tabs.service';

const STATE_TEXT = {
  starting: 'Conectando…',
  running: 'Sesión abierta en una ventana de FreeRDP',
  exited: 'Sesión cerrada',
  error: 'Error',
} as const;

@Component({
  selector: 'app-rdp-view',
  imports: [Icon],
  template: `
    <div class="card">
      <app-icon [icon]="tab().icon" [size]="64" />
      <h2>{{ tab().session.name }}</h2>
      <p class="host">
        {{ tab().session.domain ? tab().session.domain + '\\\\' : '' }}{{ tab().session.username }}&#64;{{ tab().session.host }}:{{ tab().session.port }}
        @if (tab().session.viaSshSessionId) { <span>(por túnel SSH)</span> }
      </p>
      <p class="state"><span [class]="'dot ' + tab().status()"></span> {{ text[tab().state()] }}</p>
      @if (tab().error(); as e) {
        <pre class="errtext">{{ e }}</pre>
      }
      <div class="actions">
        @if (tab().state() === 'running') {
          <button class="primary" (click)="focus()">Traer al frente</button>
          <button (click)="stop()">Desconectar</button>
        } @else if (tab().state() !== 'starting') {
          <button class="primary" (click)="tabs.launchRdp(tab())">Reconectar</button>
        }
      </div>
    </div>
  `,
  styles: `
    :host { display: grid; place-items: center; height: 100%; }
    .card { text-align: center; max-width: 560px; }
    .host { color: var(--fg-dim); font-family: monospace; }
    .state { display: flex; gap: 8px; align-items: center; justify-content: center; }
    .errtext { color: var(--danger); text-align: left; white-space: pre-wrap; background: var(--bg-2); padding: 10px; border-radius: 6px; }
    .actions { justify-content: center; }
  `,
})
export class RdpView {
  readonly tab = input.required<RdpTab>();
  protected readonly tabs = inject(TabsService);
  private readonly notice = inject(NoticeService);
  protected readonly text = STATE_TEXT;

  protected async focus(): Promise<void> {
    const id = this.tab().rdpId();
    if (id && !(await estela.invoke('rdp:focus', id))) {
      this.notice.show('No se pudo traer la ventana al frente (necesita X11 y xdotool o wmctrl).');
    }
  }

  protected stop(): void {
    const id = this.tab().rdpId();
    if (id) void estela.invoke('rdp:stop', id);
  }
}
