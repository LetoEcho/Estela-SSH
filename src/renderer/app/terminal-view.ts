import { Component, ElementRef, OnDestroy, afterNextRender, effect, inject, input, viewChild } from '@angular/core';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { parseOsc7 } from '../../shared/osc7';
import { estela } from './estela';
import { keyAction } from './keymap';
import { MultiExecService } from './multi-exec.service';
import { Tab, TabsService, type Pane } from './tabs.service';

@Component({
  selector: 'app-terminal',
  template: `
    <div #host class="host" (contextmenu)="paste($event)"></div>
    @if (multi.enabled()) {
      <label class="mx" [class.on]="multi.isSelected(pane())">
        <input type="checkbox" [checked]="multi.isSelected(pane())" (change)="multi.toggleSelected(pane())" /> multi-exec
      </label>
    }
  `,
  host: { '[class.focused]': 'focused()', '[class.multi]': 'multi.isSelected(pane())', '(focusin)': 'tab().activePane.set(pane())' },
  styles: `
    :host { display: block; height: 100%; padding: 4px 0 0 6px; background: #1e1f22; border: 1px solid transparent; position: relative; }
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
    const term = (pane.term = new Terminal({
      allowProposedApi: true, // required by the unicode11 addon
      cursorBlink: true,
      scrollback: 10_000,
      fontFamily: '"DejaVu Sans Mono", "Liberation Mono", monospace',
      fontSize: 14,
      theme: { background: '#1e1f22' },
    }));
    term.loadAddon(this.fit);
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
    // Copy on select, like PuTTY.
    term.onSelectionChange(() => {
      const sel = term.getSelection();
      if (sel) void navigator.clipboard.writeText(sel);
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
      }
      return false;
    });
  }

  /** Right click pastes, like PuTTY/MobaXterm. */
  paste(e: MouseEvent): void {
    e.preventDefault();
    void this.pasteClipboard();
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
