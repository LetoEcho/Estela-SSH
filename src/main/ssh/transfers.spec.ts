import { describe, expect, it } from 'vitest';
import type { TransferState } from '../../shared/ipc';
import { TransferQueue, type TransferRunner } from './transfers';

const job = (name: string, connId = 'c1') => ({ connId, direction: 'up' as const, name, source: `/l/${name}`, target: `/r/${name}`, size: 10 });

/** A runner whose transfers finish only when the test says so. */
function controllable() {
  const pending = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  const runner: TransferRunner = (t, progress, signal) =>
    new Promise<void>((resolve, reject) => {
      progress(5);
      pending.set(t.name, { resolve, reject });
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  return { runner, pending };
}

describe('TransferQueue', () => {
  const states = () => {
    const log: TransferState[] = [];
    const last = (name: string) => log.filter((s) => s.name === name).at(-1)?.state;
    return { log, last, emit: (s: TransferState) => log.push(s) };
  };

  it('runs at most `concurrency` transfers and starts the next when one ends', async () => {
    const { runner, pending } = controllable();
    const s = states();
    const q = new TransferQueue(runner, s.emit, 2);
    ['a', 'b', 'c'].forEach((n) => q.add(job(n)));
    await Promise.resolve();
    expect([s.last('a'), s.last('b'), s.last('c')]).toEqual(['running', 'running', 'queued']);
    pending.get('a')!.resolve();
    await new Promise((r) => setTimeout(r));
    expect([s.last('a'), s.last('c')]).toEqual(['done', 'running']);
    expect(s.log.filter((x) => x.name === 'a').at(-1)?.transferred).toBe(10);
  });

  it('cancels queued and running transfers, and reports errors', async () => {
    const { runner, pending } = controllable();
    const s = states();
    const q = new TransferQueue(runner, s.emit, 1);
    const a = q.add(job('a'));
    const b = q.add(job('b'));
    q.cancel(b);
    expect(s.last('b')).toBe('cancelled');
    q.cancel(a);
    await new Promise((r) => setTimeout(r));
    expect(s.last('a')).toBe('cancelled');

    q.add(job('c'));
    await Promise.resolve();
    pending.get('c')!.reject(new Error('disk full'));
    await new Promise((r) => setTimeout(r));
    expect(s.log.at(-1)).toMatchObject({ name: 'c', state: 'error', error: 'disk full' });
  });

  it('cancels everything of a closed connection only', async () => {
    const { runner } = controllable();
    const s = states();
    const q = new TransferQueue(runner, s.emit, 1);
    q.add(job('a', 'c1'));
    q.add(job('b', 'c2'));
    q.add(job('c', 'c1'));
    q.cancelConnection('c1');
    await new Promise((r) => setTimeout(r));
    expect([s.last('a'), s.last('b'), s.last('c')]).toEqual(['cancelled', 'running', 'cancelled']);
  });
});
