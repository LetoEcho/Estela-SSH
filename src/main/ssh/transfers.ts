import { randomUUID } from 'node:crypto';
import type { TransferState } from '../../shared/ipc';

export type TransferJob = Omit<TransferState, 'id' | 'transferred' | 'state' | 'error'>;

/** Runs one file transfer; must reject when `signal` aborts. */
export type TransferRunner = (job: TransferState, progress: (transferred: number) => void, signal: AbortSignal) => Promise<void>;

const PROGRESS_INTERVAL_MS = 200;

/** FIFO queue with bounded concurrency. Every state change is reported through `emit`. */
export class TransferQueue {
  private queue: TransferState[] = [];
  private running = new Map<string, { ac: AbortController; connId: string }>();

  constructor(
    private readonly run: TransferRunner,
    private readonly emit: (s: TransferState) => void,
    private readonly concurrency = 2,
  ) {}

  add(job: TransferJob): string {
    const t: TransferState = { ...job, id: randomUUID(), transferred: 0, state: 'queued' };
    this.queue.push(t);
    this.emit({ ...t });
    this.pump();
    return t.id;
  }

  cancel(id: string): void {
    const queued = this.queue.findIndex((t) => t.id === id);
    if (queued >= 0) {
      const [t] = this.queue.splice(queued, 1);
      this.emit({ ...t, state: 'cancelled' });
    }
    this.running.get(id)?.ac.abort();
  }

  /** Cancels everything belonging to a connection that went away. */
  cancelConnection(connId: string): void {
    for (const t of [...this.queue]) if (t.connId === connId) this.cancel(t.id);
    for (const r of this.running.values()) if (r.connId === connId) r.ac.abort();
  }

  private pump(): void {
    while (this.running.size < this.concurrency && this.queue.length) {
      const t = this.queue.shift()!;
      void this.start(t);
    }
  }

  private async start(t: TransferState): Promise<void> {
    const ac = new AbortController();
    this.running.set(t.id, { ac, connId: t.connId });
    t.state = 'running';
    this.emit({ ...t });
    let last = 0;
    try {
      await this.run(
        t,
        (n) => {
          t.transferred = n;
          const now = Date.now();
          if (now - last >= PROGRESS_INTERVAL_MS) {
            last = now;
            this.emit({ ...t });
          }
        },
        ac.signal,
      );
      t.transferred = t.size;
      t.state = 'done';
    } catch (e) {
      t.state = ac.signal.aborted ? 'cancelled' : 'error';
      if (t.state === 'error') t.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.running.delete(t.id);
    }
    this.emit({ ...t });
    this.pump();
  }
}
