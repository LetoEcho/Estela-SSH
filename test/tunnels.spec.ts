import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TunnelStatus } from '../src/shared/ipc';
import type { SshSession, Tunnel } from '../src/shared/session';
import { SshConnection, type ConnectionDeps } from '../src/main/ssh/connection';
import { TunnelManager } from '../src/main/ssh/tunnels';
import { startRealServer, type RealServer } from './real-server';

let server: RealServer;
let echo: net.Server;
let echoPort: number;
beforeAll(async () => {
  server = await startRealServer();
  echo = net.createServer((s) => s.pipe(s));
  echoPort = await new Promise((r) => echo.listen(0, '127.0.0.1', () => r((echo.address() as net.AddressInfo).port)));
});
afterAll(() => {
  server.close();
  echo.close();
});

const session = (): SshSession => ({
  type: 'ssh', id: 's', name: 't', folderId: null, color: '#fff', icon: 'x',
  host: '127.0.0.1', port: server.port, username: 'u', auth: 'password',
});
const deps = (): ConnectionDeps => ({
  findSession: () => session(),
  secrets: { get: () => 'secret', set: () => {}, canStore: () => false },
  knownHosts: { check: () => ({ result: 'match' }), add: () => {} },
  agent: () => undefined,
  askHostKey: async () => 'once',
  askAuth: async () => null,
});

/** Sends `msg` to host:port (optionally after raw `preamble` bytes) and resolves with what comes back. */
function roundTrip(port: number, msg: string, preamble?: Buffer, skip = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(preamble ? Buffer.concat([preamble, Buffer.from(msg)]) : msg));
    let got = Buffer.alloc(0);
    sock.on('data', (d: Buffer) => {
      got = Buffer.concat([got, d]);
      if (got.length >= skip + msg.length) {
        sock.destroy();
        resolve(got.subarray(skip).toString());
      }
    });
    sock.on('error', reject);
  });
}

function manager() {
  const states: TunnelStatus[] = [];
  const m = new TunnelManager(() => new SshConnection(deps()), (s) => states.push(s));
  return { m, states, last: () => states.at(-1)! };
}

describe('TunnelManager', () => {
  it('runs a local (-L) forward and stops it', async () => {
    const { m, last } = manager();
    const t: Tunnel = { id: 'l', kind: 'L', bindHost: '127.0.0.1', bindPort: 0, destHost: '127.0.0.1', destPort: echoPort, autoStart: false };
    // bindPort 0 is only valid for ephemeral tunnels in the UI, but handy here.
    await m.start('s', t);
    expect(last()).toMatchObject({ state: 'running' });
    expect(await roundTrip(last().port!, 'hola')).toBe('hola');
    m.stop('l');
    expect(last().state).toBe('stopped');
  });

  it('runs a dynamic (-D) SOCKS5 proxy', async () => {
    const { m, last } = manager();
    await m.start('s', { id: 'd', kind: 'D', bindHost: '127.0.0.1', bindPort: 0, autoStart: false });
    const socks = Buffer.from([5, 1, 0, 5, 1, 0, 1, 127, 0, 0, 1, echoPort >> 8, echoPort & 0xff]);
    // Reply bytes: 2 (method) + 10 (connect) before the echoed payload.
    expect(await roundTrip(last().port!, 'via socks', socks, 12)).toBe('via socks');
    m.stopAll();
  });

  it('runs a remote (-R) forward', async () => {
    const { m, last } = manager();
    await m.start('s', { id: 'r', kind: 'R', bindHost: '127.0.0.1', bindPort: 0, destHost: '127.0.0.1', destPort: echoPort, autoStart: false });
    expect(last().state).toBe('running');
    expect(await roundTrip(last().port!, 'remote')).toBe('remote');
    m.stopAll();
  });

  it('reports an error when the local port is taken', async () => {
    const { m, last } = manager();
    await m.start('s', { id: 'x', kind: 'L', bindHost: '127.0.0.1', bindPort: echoPort, destHost: 'h', destPort: 1, autoStart: false });
    expect(last()).toMatchObject({ state: 'error', error: expect.stringMatching(/EADDRINUSE/) });
  });

  it('gives RDP an ephemeral forward', async () => {
    const { m, states } = manager();
    const e = await m.ephemeral('s', '127.0.0.1', echoPort);
    expect(await roundTrip(e.port, 'rdp')).toBe('rdp');
    e.close();
    expect(states).toHaveLength(0); // not shown in the tunnel list
  });
});
