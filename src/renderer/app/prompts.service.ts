import { Injectable, signal } from '@angular/core';
import type { EventApi } from '../../shared/ipc';
import { estela } from './estela';

export type PendingPrompt =
  | ({ kind: 'hostkey' } & EventApi['prompt:hostkey'])
  | ({ kind: 'auth' } & EventApi['prompt:auth']);

/** Queue of questions coming from the main process; the dialog shows the first one. */
@Injectable({ providedIn: 'root' })
export class PromptsService {
  readonly queue = signal<PendingPrompt[]>([]);

  constructor() {
    estela.on('prompt:hostkey', (p) => this.queue.update((q) => [...q, { kind: 'hostkey', ...p }]));
    estela.on('prompt:auth', (p) => this.queue.update((q) => [...q, { kind: 'auth', ...p }]));
  }

  answer(p: PendingPrompt, answer: unknown): void {
    estela.send('prompt:answer', p.promptId, answer);
    this.queue.update((q) => q.filter((x) => x !== p));
  }
}
