// Integration: real ssh2 client code against in-process ssh2 servers (no Docker needed).
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Server, utils, type ParsedKey } from 'ssh2';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthAnswer, ConnStatus, HostKeyAnswer } from '../src/shared/ipc';
import type { SshSession } from '../src/shared/session';
import { SshShell, type ConnectionDeps } from '../src/main/ssh/connection';
import { KnownHosts } from '../src/main/store/known-hosts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'estela-it-'));
const clientKey = utils.generateKeyPairSync('ed25519', { passphrase: 'pp', cipher: 'aes256-ctr', rounds: 4 });
const keyFile = path.join(tmp, 'id_ed25519');
fs.writeFileSync(keyFile, clientKey.private);
const clientPub = utils.parseKey(clientKey.public) as ParsedKey;

const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

function startServer(hostKey = utils.generateKeyPairSync('ed25519').private): Promise<number> {
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.username !== 'alice') return ctx.reject();
      if (ctx.method === 'password' && ctx.password === 'secret') return ctx.accept();
      if (ctx.method === 'publickey' && ctx.key.data.equals(clientPub.getPublicSSH())) {
        if (!ctx.signature || clientPub.verify(ctx.blob!, ctx.signature, ctx.hashAlgo)) return ctx.accept();
      }
      ctx.reject(['password', 'publickey']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const s = accept();
        s.on('pty', (ok) => ok?.());
        s.on('shell', (ok) => {
          const ch = ok();
          ch.write('welcome\r\n');
          ch.on('data', (d: Buffer) => {
            if (String(d) === 'exit') return void (ch.exit(0), ch.end());
            ch.write(`echo:${d}`);
          });
        });
      });
      // Lets this server act as a jump host.
      client.on('tcpip', (accept, reject, info) => {
        const sock = net.connect(info.destPort, info.destIP, () => {
          const ch = accept();
          ch.pipe(sock).pipe(ch);
        });
        sock.on('error', () => reject());
      });
    });
    client.on('error', () => {});
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
}

function harness(sessions: SshSession[], opts: { hostKey?: HostKeyAnswer[]; auth?: AuthAnswer[]; stored?: Record<string, string> } = {}) {
  const store = new Map(Object.entries(opts.stored ?? {}));
  const deps: ConnectionDeps = {
    findSession: (id) => sessions.find((s) => s.id === id),
    secrets: {
      get: (id, kind) => store.get(`${id}:${kind}`),
      set: vi.fn((id, kind, v) => void store.set(`${id}:${kind}`, v!)),
      canStore: () => true,
    },
    knownHosts: new KnownHosts(path.join(fs.mkdtempSync(path.join(tmp, 'kh-')), 'known_hosts')),
    agent: () => undefined,
    askHostKey: vi.fn(async () => opts.hostKey?.shift() ?? 'save'),
    askAuth: vi.fn(async () => opts.auth?.shift() ?? null),
  };
  let out = '';
  const statuses: { s: ConnStatus; e?: string }[] = [];
  const shell = new SshShell(deps, { data: (d) => (out += d), status: (s, e) => statuses.push({ s, e }), hook: () => {} });
  const until = async (pred: () => boolean) => {
    for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(pred()).toBe(true);
  };
  return { deps, shell, statuses, out: () => out, until, last: () => statuses.at(-1) };
}

const session = (port: number, over: Partial<SshSession> = {}): SshSession => ({
  type: 'ssh', id: 's1', name: 't', folderId: null, color: '#fff', icon: 'x',
  host: '127.0.0.1', port, username: 'alice', auth: 'password', ...over,
});

describe('SshShell', () => {
  it('connects with a stored password, saves the host key, and relays data', async () => {
    const port = await startServer();
    const h = harness([session(port)], { stored: { 's1:password': 'secret' } });
    await h.shell.open('s1', 80, 24);
    expect(h.last()?.s).toBe('connected');
    await h.until(() => h.out().includes('welcome'));
    h.shell.write('ls');
    await h.until(() => h.out().includes('echo:ls'));
    expect(h.deps.askAuth).not.toHaveBeenCalled();
    h.shell.close();

    // Second connection: key is known, no prompt.
    const again = harness([session(port)], { stored: { 's1:password': 'secret' } });
    again.deps.knownHosts = h.deps.knownHosts;
    await again.shell.open('s1', 80, 24);
    expect(again.last()?.s).toBe('connected');
    expect(again.deps.askHostKey).not.toHaveBeenCalled();
    again.shell.close();
  });

  it('flags a changed host key and aborts when rejected', async () => {
    const port = await startServer();
    const h = harness([session(port)], { stored: { 's1:password': 'secret' }, hostKey: ['reject'] });
    // Pretend a different key was stored for this host.
    h.deps.knownHosts.add('127.0.0.1', port, (utils.parseKey(utils.generateKeyPairSync('ed25519').public) as ParsedKey).getPublicSSH());
    await h.shell.open('s1', 80, 24);
    expect(vi.mocked(h.deps.askHostKey).mock.calls[0][0].oldFingerprint).toMatch(/^SHA256:/);
    expect(h.last()?.s).toBe('error');
  });

  it('prompts after a wrong stored password and saves the new one only on success', async () => {
    const port = await startServer();
    const h = harness([session(port)], { stored: { 's1:password': 'wrong' }, auth: [{ value: 'secret', save: true }] });
    await h.shell.open('s1', 80, 24);
    expect(h.last()?.s).toBe('connected');
    expect(h.deps.secrets.set).toHaveBeenCalledWith('s1', 'password', 'secret');
    h.shell.close();
  });

  it('reports an error when the user cancels the password prompt', async () => {
    const port = await startServer();
    const h = harness([session(port)], { auth: [null] });
    await h.shell.open('s1', 80, 24);
    expect(h.last()?.s).toBe('error');
    expect(h.deps.secrets.set).not.toHaveBeenCalled();
  });

  it('authenticates with an encrypted private key, asking for the passphrase', async () => {
    const port = await startServer();
    const h = harness([session(port, { auth: 'key', keyPath: keyFile })], { auth: [{ value: 'bad', save: false }, { value: 'pp', save: false }] });
    await h.shell.open('s1', 80, 24);
    expect(h.last()).toEqual({ s: 'connected', e: undefined });
    expect(h.deps.askAuth).toHaveBeenCalledTimes(2);
    h.shell.close();
  });

  it('goes through a jump host', async () => {
    const jumpPort = await startServer();
    const targetPort = await startServer();
    const h = harness(
      [session(jumpPort, { id: 'jump' }), session(targetPort, { id: 's1', jumpSessionId: 'jump' })],
      { stored: { 'jump:password': 'secret', 's1:password': 'secret' } },
    );
    await h.shell.open('s1', 80, 24);
    expect(h.last()?.s).toBe('connected');
    expect(h.deps.askHostKey).toHaveBeenCalledTimes(2); // jump + target, each verified
    await h.until(() => h.out().includes('welcome'));
    h.shell.close();
  });

  it('reports closed when the remote shell ends', async () => {
    const port = await startServer();
    const h = harness([session(port)], { stored: { 's1:password': 'secret' } });
    await h.shell.open('s1', 80, 24);
    h.shell.write('exit');
    await h.until(() => h.last()?.s === 'closed');
    expect(h.statuses.map((x) => x.s)).toEqual(['connecting', 'connected', 'closed']);
  });

  it('reports an error for unreachable hosts', async () => {
    const h = harness([session(1)]);
    await h.shell.open('s1', 80, 24);
    expect(h.last()?.s).toBe('error');
    expect(h.last()?.e).toMatch(/ECONNREFUSED/);
  });
});

describe('SshShell handshake timeout', () => {
  it('gives up on servers that accept TCP but never speak SSH', async () => {
    let connected!: () => void;
    const accepted = new Promise<void>((r) => (connected = r));
    const silent = net.createServer(() => connected());
    const port = await new Promise<number>((r) => silent.listen(0, '127.0.0.1', () => r((silent.address() as net.AddressInfo).port)));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const h = harness([session(port)]);
      const done = h.shell.open('s1', 80, 24);
      await accepted;
      await new Promise((r) => setImmediate(r));
      await vi.advanceTimersByTimeAsync(21_000);
      await done;
      expect(h.last()).toMatchObject({ s: 'error', e: expect.stringMatching(/No SSH handshake/) });
    } finally {
      vi.useRealTimers();
      silent.close();
    }
  });
});
