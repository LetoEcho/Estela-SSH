import { Injectable, computed, inject, signal, type WritableSignal } from '@angular/core';
import { moveItemInArray } from '@angular/cdk/drag-drop';
import type { Terminal } from '@xterm/xterm';
import type { ConnStatus } from '../../shared/ipc';
import type { Session } from '../../shared/session';
import { estela } from './estela';
import { SessionsService } from './sessions.service';

/** One connection shown in one terminal. */
export class Pane {
  readonly id = crypto.randomUUID();
  readonly status = signal<ConnStatus>('connecting');
  /** Last cwd reported by the shell (OSC 7) or read from /proc. */
  readonly cwd = signal<string | null>(null);
  /** Result of the silent shell hook; null while pending. */
  readonly hook = signal<{ installed: boolean; pid?: number } | null>(null);
  /** SFTP panel state for this pane: where it is and whether it follows the terminal. */
  readonly sftpPath = signal<string | null>(null);
  readonly follow = signal(true);
  connId: string | null = null;
  cols = 80;
  rows = 24;
  /** Owned by the pane (not the view) so splitting/moving the view keeps the scrollback. */
  term?: Terminal;
  /** The DOM host of its terminal view, for directional focus. */
  el?: HTMLElement;

  constructor(readonly sessionId: string) {}
}

export type SplitDir = 'row' | 'column';
export class Split {
  readonly ratio: WritableSignal<number>;
  constructor(readonly dir: SplitDir, readonly a: LayoutNode, readonly b: LayoutNode, ratio = 0.5) {
    this.ratio = signal(ratio);
  }
}
export type LayoutNode = Pane | Split;

export class Tab {
  readonly id = crypto.randomUUID();
  readonly title: WritableSignal<string>;
  readonly color: WritableSignal<string>;
  readonly icon: string;
  readonly root: WritableSignal<LayoutNode>;
  readonly activePane: WritableSignal<Pane>;
  readonly panes = computed(() => leaves(this.root()));

  constructor(session: Session) {
    this.title = signal(session.name);
    this.color = signal(session.color);
    this.icon = session.icon;
    const pane = new Pane(session.id);
    this.root = signal<LayoutNode>(pane);
    this.activePane = signal(pane);
  }
}

const leaves = (n: LayoutNode): Pane[] => (n instanceof Pane ? [n] : [...leaves(n.a), ...leaves(n.b)]);

/** Returns a new tree where `target` is replaced; untouched subtrees keep their identity. */
function replace(n: LayoutNode, target: LayoutNode, by: LayoutNode): LayoutNode {
  if (n === target) return by;
  if (n instanceof Pane) return n;
  const a = replace(n.a, target, by);
  const b = replace(n.b, target, by);
  return a === n.a && b === n.b ? n : new Split(n.dir, a, b, n.ratio());
}

function parentOf(n: LayoutNode, target: LayoutNode): Split | null {
  if (n instanceof Pane) return null;
  if (n.a === target || n.b === target) return n;
  return parentOf(n.a, target) ?? parentOf(n.b, target);
}

const dim = (s: string) => `\r\n\x1b[90m${s}\x1b[0m\r\n`;

@Injectable({ providedIn: 'root' })
export class TabsService {
  private readonly sessions = inject(SessionsService);
  private readonly byConn = new Map<string, Pane>();

  readonly tabs = signal<Tab[]>([]);
  readonly activeId = signal<string | null>(null);
  readonly active = computed(() => this.tabs().find((t) => t.id === this.activeId()));
  /** The pane with the focus in the visible tab; the SFTP panel follows it. */
  readonly activePane = computed(() => this.active()?.activePane());

  constructor() {
    estela.on('conn:data', ({ connId, data }) => this.byConn.get(connId)?.term?.write(data));
    estela.on('conn:status', ({ connId, status, error }) => {
      const pane = this.byConn.get(connId);
      if (!pane) return;
      pane.status.set(status);
      if (status === 'error') pane.term?.write(`\r\n\x1b[31mError: ${error}\x1b[0m` + dim('Pulsa R para reconectar'));
      if (status === 'closed') pane.term?.write(dim('Conexión cerrada. Pulsa R para reconectar'));
      if (status === 'closed' || status === 'error') this.byConn.delete(connId);
    });
    estela.on('conn:hook', ({ connId, installed, pid }) => this.byConn.get(connId)?.hook.set({ installed, pid }));
  }

  open(session: Session): void {
    const tab = new Tab(session);
    this.tabs.update((t) => [...t, tab]);
    this.activeId.set(tab.id);
  }

  /** Splits the active pane of the active tab; the new pane connects to `session` (default: the same one). */
  split(dir: SplitDir, session?: Session): void {
    const tab = this.active();
    if (!tab) return session ? this.open(session) : undefined;
    const current = tab.activePane();
    const pane = new Pane(session?.id ?? current.sessionId);
    tab.root.set(replace(tab.root(), current, new Split(dir, current, pane)));
    tab.activePane.set(pane);
  }

  /** Closes a pane; the last pane closes the whole tab. */
  closePane(tab: Tab, pane: Pane): void {
    const parent = parentOf(tab.root(), pane);
    if (!parent) return this.close(tab);
    this.dispose(pane);
    const sibling = parent.a === pane ? parent.b : parent.a;
    tab.root.set(replace(tab.root(), parent, sibling));
    if (tab.activePane() === pane) tab.activePane.set(leaves(sibling)[0]);
  }

  /** Moves the focus to the nearest pane in a direction, using the panes' on-screen boxes. */
  focusDirection(tab: Tab, dx: number, dy: number): void {
    const from = tab.activePane().el?.getBoundingClientRect();
    if (!from) return;
    const cx = from.left + from.width / 2;
    const cy = from.top + from.height / 2;
    let best: { pane: Pane; d: number } | null = null;
    for (const p of tab.panes()) {
      const r = p.el?.getBoundingClientRect();
      if (!r || p === tab.activePane()) continue;
      const vx = r.left + r.width / 2 - cx;
      const vy = r.top + r.height / 2 - cy;
      if (vx * dx + vy * dy <= 0) continue; // not in that direction
      const d = Math.hypot(vx, vy);
      if (!best || d < best.d) best = { pane: p, d };
    }
    if (best) {
      tab.activePane.set(best.pane);
      best.pane.term?.focus();
    }
  }

  /** Called by the terminal once it knows its size. */
  async connect(pane: Pane): Promise<void> {
    this.disconnect(pane);
    pane.status.set('connecting');
    pane.hook.set(null);
    const connId = await estela.invoke('conn:open', pane.sessionId, pane.cols, pane.rows);
    pane.connId = connId;
    this.byConn.set(connId, pane);
  }

  reconnect(pane: Pane): void {
    pane.term?.write(dim('--- reconectando ---'));
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
    for (const p of tab.panes()) this.dispose(p);
    const list = this.tabs();
    const i = list.indexOf(tab);
    const rest = list.filter((t) => t !== tab);
    this.tabs.set(rest);
    if (this.activeId() === tab.id) this.activeId.set(rest[Math.min(i, rest.length - 1)]?.id ?? null);
  }

  duplicate(tab: Tab): void {
    const s = this.sessions.find(tab.activePane().sessionId);
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

  private dispose(pane: Pane): void {
    this.disconnect(pane);
    pane.term?.dispose();
    pane.term = undefined;
  }

  private disconnect(pane: Pane): void {
    if (!pane.connId) return;
    estela.send('conn:close', pane.connId);
    this.byConn.delete(pane.connId);
    pane.connId = null;
  }
}
