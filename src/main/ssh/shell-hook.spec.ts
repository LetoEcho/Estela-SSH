import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShellHook, hookScript } from './shell-hook';

describe('hookScript', () => {
  it('supports bash, zsh, fish and pid-only POSIX shells', () => {
    expect(hookScript('/bin/bash')).toMatchObject({ osc7: true, line: expect.stringContaining('PROMPT_COMMAND') });
    expect(hookScript('/usr/bin/zsh')).toMatchObject({ osc7: true, line: expect.stringContaining('precmd_functions') });
    expect(hookScript('/usr/bin/fish')).toMatchObject({ osc7: true, line: expect.stringContaining('fish_prompt') });
    expect(hookScript('/bin/sh')).toMatchObject({ osc7: false, line: expect.stringContaining('777;estela') });
  });
  it('types nothing into unknown shells (router CLIs, etc.)', () => {
    expect(hookScript('')).toBeNull();
    expect(hookScript('/usr/sbin/nologin')).toBeNull();
  });
  it('starts with a space and quotes the initial dir', () => {
    const s = hookScript('/bin/bash', "/srv/it's here")!.line;
    expect(s.startsWith(' ')).toBe(true);
    expect(s).toContain(`cd '/srv/it'\\''s here'`);
  });
});

describe('ShellHook', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = (script: { line: string; osc7: boolean } | null = { line: ' HOOK', osc7: true }) => {
    const written: string[] = [];
    const shown: string[] = [];
    const done = vi.fn();
    const hook = new ShellHook(Promise.resolve(script), (s) => written.push(s), (s) => shown.push(s), done);
    return { hook, written, shown: () => shown.join(''), done };
  };

  it('injects after the prompt settles, hides the echo and erases the old prompt', async () => {
    const t = setup();
    t.hook.data('Welcome\r\n$ ');
    expect(t.written).toEqual([]);
    await vi.advanceTimersByTimeAsync(300);
    expect(t.written).toEqual([' HOOK\n']);
    t.hook.data(' HOOK\r\n');
    t.hook.data('\x1b]777;est');
    t.hook.data('ela;4242\x1b\\\x1b]7;file://h/home\x1b\\$ ');
    expect(t.shown()).toBe('Welcome\r\n$ \r\x1b[2K\x1b]7;file://h/home\x1b\\$ ');
    expect(t.done).toHaveBeenCalledWith({ pid: 4242, installed: true });
  });

  it('reports pid-only shells as not installed so the /proc fallback kicks in', async () => {
    const t = setup({ line: ' PID', osc7: false });
    t.hook.data('$ ');
    await vi.advanceTimersByTimeAsync(300);
    t.hook.data('\x1b]777;estela;99\x1b\\$ ');
    expect(t.done).toHaveBeenCalledWith({ pid: 99, installed: false });
  });

  it('gives up if the user types first', async () => {
    const t = setup();
    t.hook.data('$ ');
    t.hook.userInput();
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.written).toEqual([]);
    expect(t.done).toHaveBeenCalledWith({ pid: undefined, installed: false });
  });

  it('never injects into unknown shells', async () => {
    const t = setup(null);
    t.hook.data('router> ');
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.written).toEqual([]);
    expect(t.shown()).toBe('router> ');
  });

  it('releases held output if the marker never comes', async () => {
    const t = setup();
    t.hook.data('$ ');
    await vi.advanceTimersByTimeAsync(300);
    t.hook.data('syntax error\r\n$ ');
    await vi.advanceTimersByTimeAsync(3000);
    expect(t.shown()).toBe('$ syntax error\r\n$ ');
    expect(t.done).toHaveBeenCalledWith({ pid: undefined, installed: false });
  });

  it('can be retried on demand', async () => {
    const t = setup();
    t.hook.data('$ ');
    t.hook.userInput();
    t.hook.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.written).toEqual([' HOOK\n']);
  });
});
