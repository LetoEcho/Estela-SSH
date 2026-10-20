import { Injectable, computed, inject, signal, type WritableSignal } from '@angular/core';
import { moveItemInArray } from '@angular/cdk/drag-drop';
import type { ConnStatus } from '../../shared/ipc';
import type { Session } from '../../shared/session';
import { estela } from './estela';
import { SessionsService } from './sessions.service';

/** One connection shown in one terminal. Tabs hold one pane until splits arrive (phase 2). */
export class Pane {
  readonly id = crypto.randomUUID();
  readonly status = signal<ConnStatus>('connecting');
  connId: string | null = null;
  cols = 80;
  rows = 24;
  /** Set by the terminal view; receives remote output. */
  sink?: (data: string) => void;

  constructor(readonly sessionId: string) {}
}

export class Tab {
  readonly id = crypto.randomUUID();
  readonly title: WritableSignal<string>;
  readonly color: WritableSignal<string>;
  readonly icon: string;
  readonly pane: Pane;

  constructor(session: Session) {
    this.title = signal(session.name);
    this.color = signal(session.color);
    this.icon = session.icon;
    this.pane = new Pane(session.id);
  }
}

const dim = (s: string) => `\r\n\x1b[90m${s}\x1b[0m\r\n`;

@Injectable({ providedIn: 'root' })
export class TabsService {
  private readonly sessions = inject(SessionsService);
  private readonly byConn = new Map<string, Pane>();

  readonly tabs = signal<Tab[]>([]);
  readonly activeId = signal<string | null>(null);
  readonly active = computed(() => this.tabs().find((t) => t.id === this.activeId()));

  constructor() {
    estela.on('conn:data', ({ connId, data }) => this.byConn.get(connId)?.sink?.(data));
    estela.on('conn:status', ({ connId, status, error }) => {
      const pane = this.byConn.get(connId);
      if (!pane) return;
      pane.status.set(status);
      if (status === 'error') pane.sink?.(`\r\n\x1b[31mError: ${error}\x1b[0m` + dim('Pulsa R para reconectar'));
      if (status === 'closed') pane.sink?.(dim('Conexión cerrada. Pulsa R para reconectar'));
      if (status === 'closed' || status === 'error') this.byConn.delete(connId);
    });
  }

  open(session: Session): void {
    const tab = new Tab(session);
    this.tabs.update((t) => [...t, tab]);
    this.activeId.set(tab.id);
  }

  /** Called by the terminal once it knows its size. */
  async connect(pane: Pane): Promise<void> {
    this.disconnect(pane);
    pane.status.set('connecting');
    const connId = await estela.invoke('conn:open', pane.sessionId, pane.cols, pane.rows);
    pane.connId = connId;
    this.byConn.set(connId, pane);
  }

  reconnect(pane: Pane): void {
    pane.sink?.(dim('--- reconectando ---'));
    void this.connect(pane);
  }

  write(pane: Pane, data: string): void {
    if (pane.connId) estela.send('conn:write', pane.connId, data);
  }

  resize(pane: Pane, cols: number, rows: number): void {
    pane.cols = cols;
    pane.rows = rows;
    if (pane.connId) estela.send('conn:resize', pane.connId, cols, rows);
  }

  close(tab: Tab): void {
    this.disconnect(tab.pane);
    const list = this.tabs();
    const i = list.indexOf(tab);
    const rest = list.filter((t) => t !== tab);
    this.tabs.set(rest);
    if (this.activeId() === tab.id) this.activeId.set(rest[Math.min(i, rest.length - 1)]?.id ?? null);
  }

  duplicate(tab: Tab): void {
    const s = this.sessions.find(tab.pane.sessionId);
    if (s) this.open(s);
  }

  move(from: number, to: number): void {
    this.tabs.update((t) => {
      const copy = [...t];
      moveItemInArray(copy, from, to);
      return copy;
    });
  }

  cycle(step: 1 | -1): void {
    const list = this.tabs();
    const i = list.findIndex((t) => t.id === this.activeId());
    if (list.length) this.activeId.set(list[(i + step + list.length) % list.length].id);
  }

  private disconnect(pane: Pane): void {
    if (!pane.connId) return;
    estela.send('conn:close', pane.connId);
    this.byConn.delete(pane.connId);
    pane.connId = null;
  }
}
