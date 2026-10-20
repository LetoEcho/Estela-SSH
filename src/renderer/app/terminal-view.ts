import { Component, ElementRef, OnDestroy, afterNextRender, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { parseOsc7 } from '../../shared/osc7';
import { ContextMenu, type MenuState } from './context-menu';
import { estela } from './estela';
import { keyAction } from './keymap';
import { MultiExecService } from './multi-exec.service';
import { SettingsService } from './settings.service';
import { TERMINAL_THEMES } from './themes';
import { Tab, TabsService, type Pane } from './tabs.service';

@Component({
  selector: 'app-terminal',
  imports: [ContextMenu],
  template: `
    <div #host class="host" (contextmenu)="contextMenu($event)"></div>
    @if (searching()) {
      <div class="search">
        <input #q placeholder="Buscar…" [value]="query()" (input)="find($any($event.target).value)"
               (keydown.enter)="$any($event).shiftKey ? findPrev() : findNext()" (keydown.escape)="closeSearch()" />
        <button class="icon" title="Anterior (Shift+Enter)" (click)="findPrev()">↑</button>
        <button class="icon" title="Siguiente (Enter)" (click)="findNext()">↓</button>
        <button class="icon" title="Cerrar (Esc)" (click)="closeSearch()">✕</button>
      </div>
    }
    @if (menu(); as m) {
      <app-context-menu [state]="m" (closed)="menu.set(null)" />
    }
    @if (multi.enabled()) {
      <label class="mx" [class.on]="multi.isSelected(pane())">
        <input type="checkbox" [checked]="multi.isSelected(pane())" (change)="multi.toggleSelected(pane())" /> multi-exec
      </label>
    }
  `,
  host: { '[class.focused]': 'focused()', '[class.multi]': 'multi.isSelected(pane())', '(focusin)': 'tab().activePane.set(pane())' },
  styles: `
    :host { display: block; height: 100%; padding: 4px 0 0 6px; background: var(--term-bg); border: 1px solid transparent; position: relative; }
    .search { position: absolute; top: 4px; right: 18px; z-index: 11; display: flex; gap: 2px; background: var(--bg-2);
              border: 1px solid var(--border); border-radius: 6px; padding: 3px; box-shadow: 0 2px 8px rgb(0 0 0 / .3); }
    .search input { width: 200px; }
    :host(.focused) { border-color: var(--accent); }
    :host(.multi) { border-color: var(--warn); }
    .host { height: 100%; }
    .mx { position: absolute; top: 4px; right: 18px; z-index: 10; background: var(--bg-3); padding: 2px 8px; border-radius: 4px;
          font-size: 12px; opacity: 0.85; }
    .mx.on { background: color-mix(in srgb, var(--warn) 45%, var(--bg-3)); }
  `,
})
export class TerminalView implements OnDestroy {
  readonly pane = input.required<Pane>();
  readonly tab = input.required<Tab>();
  readonly visible = input(false);
  /** Highlight only matters when the tab is split. */
  readonly focused = input(false);
  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  private readonly tabs = inject(TabsService);
  protected readonly multi = inject(MultiExecService);
  private readonly settings = inject(SettingsService);
  protected readonly searching = signal(false);
  protected readonly query = signal('');
  protected readonly menu = signal<MenuState | null>(null);
  private readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('q');
  private fit = new FitAddon();
  private observer?: ResizeObserver;

  constructor() {
    afterNextRender(() => this.attach());
    effect(() => {
      if (this.visible()) requestAnimationFrame(() => this.refit());
    });
    effect(() => {
      if (this.visible() && this.tab().activePane() === this.pane()) requestAnimationFrame(() => this.pane().term?.focus());
    });
    // Live settings: theme, font and scrollback apply to open terminals too.
    effect(() => {
      const s = this.settings.value();
      const theme = TERMINAL_THEMES[this.settings.theme()];
      untracked(() => {
        const term = this.pane().term;
        if (!term) return;
        term.options.theme = theme;
        term.options.fontFamily = s.fontFamily;
        term.options.fontSize = s.fontSize;
        term.options.scrollback = s.scrollback;
        requestAnimationFrame(() => this.refit());
      });
    });
    effect(() => this.searchInput()?.nativeElement.focus());
  }

  /** First time: create the terminal and connect. Later (after a split re-renders us): just move its DOM. */
  private attach(): void {
    const pane = this.pane();
    const el = this.host().nativeElement;
    pane.el = el;
    if (pane.term?.element) {
      el.appendChild(pane.term.element);
      pane.term.loadAddon(this.fit);
    } else {
      this.create(pane, el);
    }
    this.observer = new ResizeObserver(() => this.refit());
    this.observer.observe(el);
    this.refit();
    if (!pane.connId && pane.status() === 'connecting') {
      pane.cols = pane.term!.cols;
      pane.rows = pane.term!.rows;
      void this.tabs.connect(pane);
    }
  }

  private create(pane: Pane, el: HTMLElement): void {
    const s = this.settings.value();
    const term = (pane.term = new Terminal({
      allowProposedApi: true, // required by the unicode11 addon
      cursorBlink: true,
      scrollback: s.scrollback,
      fontFamily: s.fontFamily,
      fontSize: s.fontSize,
      theme: TERMINAL_THEMES[this.settings.theme()],
    }));
    term.loadAddon(this.fit);
    term.loadAddon((pane.search = new SearchAddon()));
    term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri))); // main opens http(s) externally
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    term.open(el);

    // OSC 7 (file://host/path) from the shell hook keeps the SFTP panel in sync.
    term.parser.registerOscHandler(7, (data) => {
      const p = parseOsc7(data);
      if (p) pane.cwd.set(p);
      return true;
    });
    term.onData((d) => {
      const s = pane.status();
      if (s === 'connected') {
        if (!this.multi.broadcast(pane, d)) this.tabs.write(pane, d);
      }
      else if ((s === 'closed' || s === 'error') && d.toLowerCase() === 'r') this.tabs.reconnect(pane);
    });
    term.onResize(({ cols, rows }) => this.tabs.resize(pane, cols, rows));
    // Copy on select, like PuTTY (optional).
    term.onSelectionChange(() => {
      const sel = term.getSelection();
      if (sel && this.settings.value().copyOnSelect) void navigator.clipboard.writeText(sel);
    });
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const action = keyAction(estela.os, e);
      if (!action) return true;
      e.preventDefault();
      const tab = this.tabs.tabs().find((t): t is Tab => t instanceof Tab && t.panes().includes(pane));
      switch (action) {
        case 'copy': void navigator.clipboard.writeText(term.getSelection()); break;
        case 'paste': void this.pasteClipboard(); break;
        case 'nextTab': this.tabs.cycle(1); break;
        case 'prevTab': this.tabs.cycle(-1); break;
        case 'closePane': if (tab) this.tabs.closePane(tab, pane); break;
        case 'splitRight': this.tabs.split('row'); break;
        case 'splitDown': this.tabs.split('column'); break;
        case 'focusLeft': if (tab) this.tabs.focusDirection(tab, -1, 0); break;
        case 'focusRight': if (tab) this.tabs.focusDirection(tab, 1, 0); break;
        case 'focusUp': if (tab) this.tabs.focusDirection(tab, 0, -1); break;
        case 'focusDown': if (tab) this.tabs.focusDirection(tab, 0, 1); break;
        case 'search': this.searching.set(true); break;
      }
      return false;
    });
  }

  /** Right click pastes, like PuTTY; if disabled, it shows a small menu instead. */
  protected contextMenu(e: MouseEvent): void {
    e.preventDefault();
    if (this.settings.value().rightClickPaste) return void this.pasteClipboard();
    const term = this.pane().term;
    this.menu.set({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Copiar', action: () => void navigator.clipboard.writeText(term?.getSelection() ?? '') },
        { label: 'Pegar', action: () => void this.pasteClipboard() },
        { label: 'Buscar… (Ctrl+Shift+F)', action: () => this.searching.set(true) },
        { label: 'Limpiar pantalla', action: () => term?.clear() },
      ],
    });
  }

  protected find(q: string): void {
    this.query.set(q);
    this.pane().search?.findNext(q, { incremental: true });
  }

  protected findNext(): void {
    this.pane().search?.findNext(this.query());
  }

  protected findPrev(): void {
    this.pane().search?.findPrevious(this.query());
  }

  protected closeSearch(): void {
    this.searching.set(false);
    this.pane().search?.clearDecorations();
    this.pane().term?.clearSelection();
    this.pane().term?.focus();
  }

  private async pasteClipboard(): Promise<void> {
    const text = await navigator.clipboard.readText();
    if (text) this.pane().term?.paste(text);
  }

  private refit(): void {
    // Hidden tabs have no size; fitting them would shrink the remote pty to nothing.
    if (this.pane().term && this.host().nativeElement.offsetParent) this.fit.fit();
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
    this.fit.dispose();
  }
}
