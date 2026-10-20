import { Component, ElementRef, OnDestroy, afterNextRender, effect, inject, input, viewChild } from '@angular/core';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { estela } from './estela';
import { keyAction } from './keymap';
import { TabsService, type Pane } from './tabs.service';

@Component({
  selector: 'app-terminal',
  template: '<div #host class="host" (contextmenu)="paste($event)"></div>',
  styles: `
    :host { display: block; height: 100%; padding: 4px 0 0 6px; background: #1e1f22; }
    .host { height: 100%; }
  `,
})
export class TerminalView implements OnDestroy {
  readonly pane = input.required<Pane>();
  readonly visible = input(false);
  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  private readonly tabs = inject(TabsService);
  private term?: Terminal;
  private fit = new FitAddon();
  private observer?: ResizeObserver;

  constructor() {
    afterNextRender(() => this.init());
    effect(() => {
      if (this.visible()) requestAnimationFrame(() => (this.refit(), this.term?.focus()));
    });
  }

  private init(): void {
    const pane = this.pane();
    const term = (this.term = new Terminal({
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
    term.open(this.host().nativeElement);

    pane.sink = (d) => term.write(d);
    term.onData((d) => {
      const s = pane.status();
      if (s === 'connected') this.tabs.write(pane, d);
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
      if (action === 'copy') void navigator.clipboard.writeText(term.getSelection());
      else if (action === 'paste') void this.pasteClipboard();
      else if (action === 'nextTab') this.tabs.cycle(1);
      else if (action === 'prevTab') this.tabs.cycle(-1);
      else if (action === 'closeTab') {
        const tab = this.tabs.active();
        if (tab) this.tabs.close(tab);
      }
      return false;
    });

    this.observer = new ResizeObserver(() => this.refit());
    this.observer.observe(this.host().nativeElement);
    this.refit();
    pane.cols = term.cols;
    pane.rows = term.rows;
    void this.tabs.connect(pane);
  }

  /** Right click pastes, like PuTTY/MobaXterm. */
  paste(e: MouseEvent): void {
    e.preventDefault();
    void this.pasteClipboard();
  }

  private async pasteClipboard(): Promise<void> {
    const text = await navigator.clipboard.readText();
    if (text) this.term?.paste(text);
  }

  private refit(): void {
    // Hidden tabs have no size; fitting them would shrink the remote pty to nothing.
    if (this.term && this.host().nativeElement.offsetParent) this.fit.fit();
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
    this.pane().sink = undefined;
    this.term?.dispose();
  }
}
