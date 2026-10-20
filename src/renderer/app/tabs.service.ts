import { Injectable, computed, inject, signal, type WritableSignal } from '@angular/core';
import { moveItemInArray } from '@angular/cdk/drag-drop';
import type { SearchAddon } from '@xterm/addon-search';
import type { Terminal } from '@xterm/xterm';
import type { ConnStatus, LocalShell, RdpStatus } from '../../shared/ipc';
import type { RdpSession, Session, SshSession } from '../../shared/session';
import { estela } from './estela';
import { SessionsService } from './sessions.service';
import { SettingsService } from './settings.service';

const RECONNECT_DELAYS_S = [2, 4, 8, 16, 30];
/** Errors where retrying cannot help (or would hammer a server with a bad password). */
const NO_RETRY = /authenticat|host key|cancel|not found|no ssh agent|passphrase/i;

/** What a pane connects to. */
export type PaneTarget = { kind: 'ssh'; sessionId: string } | { kind: 'local'; shell: LocalShell };

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
  search?: SearchAddon;
  /** Automatic reconnection attempts in a row (reset when connected). */
  reconnectAttempts = 0;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  /** The DOM host of its terminal view, for directional focus. */
  el?: HTMLElement;

  constructor(readonly target: PaneTarget) {}

  get isLocal(): boolean {
    return this.target.kind === 'local';
  }
}

export type SplitDir = 'row' | 'column';
export class Split {
  readonly ratio: WritableSignal<number>;
  constructor(readonly dir: SplitDir, readonly a: LayoutNode, readonly b: LayoutNode, ratio = 0.5) {
    this.ratio = signal(ratio);
  }
}
export type LayoutNode = Pane | Split;

interface TabLook {
  name: string;
  color: string;
  icon: string;
}

abstract class BaseTab {
  readonly id = crypto.randomUUID();
  readonly title: WritableSignal<string>;
  readonly color: WritableSignal<string>;
  readonly icon: string;

  constructor(look: TabLook) {
    this.title = signal(look.name);
    this.color = signal(look.color);
    this.icon = look.icon;
  }
}

/** Terminal tab: a layout tree of panes. */
export class Tab extends BaseTab {
  readonly kind = 'term';
  readonly root: WritableSignal<LayoutNode>;
  readonly activePane: WritableSignal<Pane>;
  readonly panes = computed(() => leaves(this.root()));
  readonly status = computed<ConnStatus>(() => this.activePane().status());

  constructor(look: TabLook, target: PaneTarget) {
    super(look);
    const pane = new Pane(target);
    this.root = signal<LayoutNode>(pane);
    this.activePane = signal(pane);
  }
}

/** RDP tab: the session runs in an external FreeRDP window; the tab shows its state. */
export class RdpTab extends BaseTab {
  readonly kind = 'rdp';
  readonly rdpId = signal<string | null>(null);
  readonly state = signal<RdpStatus['state']>('starting');
  readonly error = signal<string | undefined>(undefined);
  readonly status = computed<ConnStatus>(() => {
    const s = this.state();
    return s === 'running' ? 'connected' : s === 'starting' ? 'connecting' : s === 'exited' ? 'closed' : 'error';
  });

  constructor(readonly session: RdpSession) {
    super(session);
  }
}

export type AnyTab = Tab | RdpTab;

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
  private readonly settings = inject(SettingsService);
  private readonly byConn = new Map<string, Pane>();

  private readonly byRdp = new Map<string, RdpTab>();

  readonly tabs = signal<AnyTab[]>([]);
  readonly activeId = signal<string | null>(null);
  readonly active = computed(() => this.tabs().find((t) => t.id === this.activeId()));
  /** Active terminal tab, if the visible tab is one. */
  readonly activeTerm = computed(() => {
    const t = this.active();
    return t instanceof Tab ? t : undefined;
  });
  /** The pane with the focus in the visible tab; the SFTP panel follows it. */
  readonly activePane = computed(() => this.activeTerm()?.activePane());
  /** Every pane of every terminal tab (multi-exec chooses among them). */
  readonly allPanes = computed(() => this.tabs().flatMap((t) => (t instanceof Tab ? t.panes() : [])));

  constructor() {
    estela.on('conn:data', ({ connId, data }) => this.byConn.get(connId)?.term?.write(data));
    estela.on('conn:status', ({ connId, status, error }) => {
      const pane = this.byConn.get(connId);
      if (!pane) return;
      pane.status.set(status);
      if (status === 'connected') pane.reconnectAttempts = 0;
      if (status === 'closed') pane.term?.write(dim('Conexión cerrada. Pulsa R para reconectar'));
      if (status === 'error') {
        pane.term?.write(`\r\n\x1b[31mError: ${error}\x1b[0m`);
        const auto = pane.target.kind === 'ssh' && this.settings.value().autoReconnect && !NO_RETRY.test(error ?? '');
        if (auto) this.scheduleReconnect(pane);
        else pane.term?.write(dim('Pulsa R para reconectar'));
      }
      if (status === 'closed' || status === 'error') this.byConn.delete(connId);
    });
    estela.on('conn:hook', ({ connId, installed, pid }) => this.byConn.get(connId)?.hook.set({ installed, pid }));
    estela.on('rdp:status', ({ rdpId, state, error }) => {
      const tab = this.byRdp.get(rdpId);
      tab?.state.set(state);
      tab?.error.set(error);
    });
  }

  open(session: Session): void {
    if (session.type === 'rdp') return this.openRdp(session);
    this.add(new Tab(session, { kind: 'ssh', sessionId: session.id }));
  }

  openLocal(shell: LocalShell): void {
    this.add(new Tab({ name: shell.name, color: '#abb2bf', icon: '💻' }, { kind: 'local', shell }));
  }

  private openRdp(session: RdpSession): void {
    const tab = new RdpTab(session);
    this.add(tab);
    void this.launchRdp(tab);
  }

  async launchRdp(tab: RdpTab): Promise<void> {
    const old = tab.rdpId();
    if (old) this.byRdp.delete(old);
    tab.state.set('starting');
    tab.error.set(undefined);
    const rdpId = await estela.invoke('rdp:launch', tab.session.id);
    tab.rdpId.set(rdpId);
    this.byRdp.set(rdpId, tab);
  }

  private add(tab: AnyTab): void {
    this.tabs.update((t) => [...t, tab]);
    this.activeId.set(tab.id);
  }

  /** Splits the active pane of the active tab; the new pane connects to `session` (default: the same target). */
  split(dir: SplitDir, session?: SshSession): void {
    const tab = this.activeTerm();
    if (!tab) return session ? this.open(session) : undefined;
    const current = tab.activePane();
    const pane = new Pane(session ? { kind: 'ssh', sessionId: session.id } : current.target);
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
    const t = pane.target;
    const connId =
      t.kind === 'ssh'
        ? await estela.invoke('conn:open', t.sessionId, pane.cols, pane.rows)
        : await estela.invoke('conn:openLocal', t.shell.path, pane.cols, pane.rows);
    pane.connId = connId;
    this.byConn.set(connId, pane);
  }

  reconnect(pane: Pane): void {
    clearTimeout(pane.reconnectTimer);
    pane.term?.write(dim('--- reconectando ---'));
    void this.connect(pane);
  }

  /** Network drop: retry with growing delays; R still reconnects at once. */
  private scheduleReconnect(pane: Pane): void {
    const n = pane.reconnectAttempts;
    if (n >= RECONNECT_DELAYS_S.length) {
      pane.term?.write(dim('Reconexión automática agotada. Pulsa R para reintentar'));
      return;
    }
    const delay = RECONNECT_DELAYS_S[n];
    pane.reconnectAttempts++;
    pane.term?.write(dim(`Reconectando en ${delay} s (intento ${n + 1}/${RECONNECT_DELAYS_S.length})… pulsa R para hacerlo ya`));
    pane.reconnectTimer = setTimeout(() => {
      if (pane.term && pane.status() === 'error') this.reconnect(pane);
    }, delay * 1000);
  }

  write(pane: Pane, data: string): void {
    if (pane.connId) estela.send('conn:write', pane.connId, data);
  }

  resize(pane: Pane, cols: number, rows: number): void {
    pane.cols = cols;
    pane.rows = rows;
    if (pane.connId) estela.send('conn:resize', pane.connId, cols, rows);
  }

  close(tab: AnyTab): void {
    if (tab instanceof Tab) for (const p of tab.panes()) this.dispose(p);
    else {
      const id = tab.rdpId();
      if (id && tab.state() !== 'exited' && tab.state() !== 'error') void estela.invoke('rdp:stop', id);
    }
    const list = this.tabs();
    const i = list.indexOf(tab);
    const rest = list.filter((t) => t !== tab);
    this.tabs.set(rest);
    if (this.activeId() === tab.id) this.activeId.set(rest[Math.min(i, rest.length - 1)]?.id ?? null);
  }

  duplicate(tab: AnyTab): void {
    if (tab instanceof RdpTab) return this.open(tab.session);
    const t = tab.activePane().target;
    if (t.kind === 'local') return this.openLocal(t.shell);
    const s = this.sessions.find(t.sessionId);
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
    clearTimeout(pane.reconnectTimer);
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
