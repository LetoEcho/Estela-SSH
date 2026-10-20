// Shell hook + SFTP against real bash and OpenSSH's sftp-server.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SshSession } from '../src/shared/session';
import { SshShell, type ConnectionDeps } from '../src/main/ssh/connection';
import { call, list, mkdirp, remove, transferFile, walk } from '../src/main/ssh/sftp';
import { HAS_SCRIPT, SFTP_SERVER, startRealServer, type RealServer } from './real-server';

const enabled = !!SFTP_SERVER && HAS_SCRIPT;
let server: RealServer;
beforeAll(async () => {
  if (enabled) server = await startRealServer();
});
afterAll(() => server?.close());

async function connect(initialDir?: string) {
  const session: SshSession = {
    type: 'ssh', id: 's', name: 'real', folderId: null, color: '#fff', icon: 'x',
    host: '127.0.0.1', port: server.port, username: 'u', auth: 'password', initialDir,
  };
  const deps: ConnectionDeps = {
    findSession: () => session,
    secrets: { get: () => 'secret', set: () => {}, canStore: () => false },
    knownHosts: { check: () => ({ result: 'match' }), add: () => {} },
    agent: () => undefined,
    askHostKey: async () => 'once',
    askAuth: async () => null,
  };
  let out = '';
  const hook = vi.fn();
  const shell = new SshShell(deps, { data: (d) => (out += d), status: () => {}, hook });
  await shell.open('s', 120, 40);
  const until = async (pred: () => boolean, ms = 5000) => {
    for (let t = 0; t < ms && !pred(); t += 20) await new Promise((r) => setTimeout(r, 20));
    expect(pred()).toBe(true);
  };
  return { shell, out: () => out, hook, until };
}

describe.runIf(enabled)('real bash + sftp-server', () => {
  it('installs the OSC 7 hook silently and reports the pid', async () => {
    const c = await connect();
    await c.until(() => c.hook.mock.calls.length > 0);
    expect(c.hook).toHaveBeenCalledWith({ installed: true, pid: expect.any(Number) });
    // The injected line and the pid marker never reach the terminal…
    expect(c.out()).not.toContain('__estela_osc7');
    expect(c.out()).not.toContain('777;estela');
    // …but every prompt now carries the cwd.
    c.shell.write('cd /tmp\n');
    await c.until(() => c.out().includes('\x1b]7;file://') && c.out().includes('/tmp\x1b\\'));
    // The /proc fallback agrees.
    expect(await c.shell.cwd()).toBe('/tmp');
    // And the hook line is not in history.
    c.shell.write('history\n');
    await c.until(() => /\d+\s+history/.test(c.out()));
    expect(c.out().split('history')[1]).not.toContain('__estela');
    c.shell.close();
  });

  it('applies the initial directory through the hook', async () => {
    fs.mkdirSync(path.join(server.home, 'logs'));
    const c = await connect(path.join(server.home, 'logs'));
    await c.until(() => c.out().includes(`${server.home}/logs\x1b\\`));
    c.shell.close();
  });

  it('does not inject when the user types before the prompt settles', async () => {
    const c = await connect();
    c.shell.write('echo hi\n');
    await c.until(() => c.hook.mock.calls.length > 0);
    expect(c.hook).toHaveBeenCalledWith({ installed: false, pid: undefined });
    c.shell.close();
  });

  it('lists, creates, walks and removes over SFTP', async () => {
    const c = await connect();
    const sftp = await c.shell.sftp();
    const home = await call<string>((cb) => sftp.realpath('.', cb));
    const base = path.posix.join(home, 'tree');
    await mkdirp(sftp, `${base}/a/b`);
    fs.writeFileSync(path.join(server.home, 'tree/a/b/f.txt'), 'hello');
    fs.writeFileSync(path.join(server.home, 'tree/top.txt'), 'x');
    fs.symlinkSync(path.join(server.home, 'tree/a'), path.join(server.home, 'tree/link'));

    const entries = await list(sftp, base);
    expect(entries.map((e) => [e.name, e.type, e.isDir])).toEqual([
      ['a', 'dir', true],
      ['link', 'link', true],
      ['top.txt', 'file', false],
    ]);
    const tree = await walk(sftp, base);
    expect(tree.files.map((f) => path.posix.relative(base, f.path)).sort()).toEqual(['a/b/f.txt', 'top.txt']);

    await remove(sftp, base);
    expect(fs.existsSync(path.join(server.home, 'tree'))).toBe(false);
    c.shell.close();
  });

  it('uploads and downloads with progress, and cleans up a cancelled download', async () => {
    const c = await connect();
    const local = path.join(server.home, 'local-big.bin');
    fs.writeFileSync(local, Buffer.alloc(3 * 1024 * 1024, 7));
    const sftp = await c.shell.openSftp();
    const home = await call<string>((cb) => sftp.realpath('.', cb));
    const steps: number[] = [];
    const never = new AbortController().signal;

    await transferFile(sftp, { direction: 'up', source: local, target: `${home}/up.bin` }, (n) => steps.push(n), never, () => c.shell.sftp());
    expect(fs.statSync(path.join(server.home, 'up.bin')).size).toBe(3 * 1024 * 1024);
    expect(steps.at(-1)).toBe(3 * 1024 * 1024);

    const down = path.join(server.home, 'down.bin');
    await transferFile(sftp, { direction: 'down', source: `${home}/up.bin`, target: down }, () => {}, never, () => c.shell.sftp());
    expect(fs.readFileSync(down).equals(fs.readFileSync(local))).toBe(true);

    const ac = new AbortController();
    const partial = path.join(server.home, 'partial.bin');
    const other = await c.shell.openSftp();
    const run = transferFile(other, { direction: 'down', source: `${home}/up.bin`, target: partial }, () => ac.abort(), ac.signal, () => c.shell.sftp());
    await expect(run).rejects.toThrow('cancelled');
    expect(fs.existsSync(partial)).toBe(false);
    sftp.end();
    c.shell.close();
  });
});
