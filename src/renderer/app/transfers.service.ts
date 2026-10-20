import { Injectable, computed, signal } from '@angular/core';
import type { TransferState } from '../../shared/ipc';
import { estela } from './estela';

@Injectable({ providedIn: 'root' })
export class TransfersService {
  private readonly byId = signal(new Map<string, TransferState>());
  readonly list = computed(() => [...this.byId().values()]);
  readonly active = computed(() => this.list().filter((t) => t.state === 'queued' || t.state === 'running').length);
  /** Last finished transfer; the SFTP panel refreshes when it lands in the directory it shows. */
  readonly lastFinished = signal<TransferState | null>(null);

  constructor() {
    estela.on('transfer:update', (t) => {
      this.byId.update((m) => new Map(m).set(t.id, t));
      if (t.state === 'done') this.lastFinished.set(t);
    });
  }

  cancel = (id: string) => estela.invoke('transfer:cancel', id);

  clearFinished(): void {
    this.byId.update((m) => new Map([...m].filter(([, t]) => t.state === 'queued' || t.state === 'running')));
  }
}
