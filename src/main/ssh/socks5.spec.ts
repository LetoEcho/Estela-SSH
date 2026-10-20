import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { acceptSocks5, type SocksRequest } from './socks5';

const servers: net.Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

/** Starts a SOCKS server that records requests and answers `ok`. */
function serve(ok: boolean): Promise<{ port: number; requests: SocksRequest[] }> {
  const requests: SocksRequest[] = [];
  const server = net.createServer((sock) => {
    acceptSocks5(sock).then((r) => (requests.push(r), r.reply(ok)), () => {});
  });
  servers.push(server);
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ port: (server.address() as net.AddressInfo).port, requests })));
}

function client(port: number, ...chunks: number[][]): Promise<Buffer> {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => chunks.forEach((c) => sock.write(Buffer.from(c))));
    let got = Buffer.alloc(0);
    sock.on('data', (d: Buffer) => {
      got = Buffer.concat([got, d]);
      if (got.length >= 12 || (got.length === 2 && got[1] === 0xff)) (sock.destroy(), resolve(got));
    });
    sock.on('close', () => resolve(got));
  });
}

describe('acceptSocks5', () => {
  it('parses a domain CONNECT, even split across packets', async () => {
    const s = await serve(true);
    const name = [...Buffer.from('db.internal')];
    const reply = await client(s.port, [5, 1, 0], [5, 1, 0, 3, name.length, ...name.slice(0, 3)], [...name.slice(3), 0x15, 0x38]);
    expect(s.requests[0]).toMatchObject({ host: 'db.internal', port: 5432 });
    expect([...reply]).toEqual([5, 0, 5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
  });

  it('parses IPv4 and IPv6 targets', async () => {
    const s = await serve(true);
    await client(s.port, [5, 1, 0, 5, 1, 0, 1, 10, 0, 0, 7, 0, 22]);
    await client(s.port, [5, 1, 0, 5, 1, 0, 4, ...Array(15).fill(0), 1, 0, 80]);
    expect(s.requests.map((r) => `${r.host}:${r.port}`)).toEqual(['10.0.0.7:22', '0:0:0:0:0:0:0:1:80']);
  });

  it('refuses authentication-only clients and non-CONNECT commands', async () => {
    const s = await serve(true);
    expect([...(await client(s.port, [5, 1, 2]))]).toEqual([5, 0xff]);
    const bind = await client(s.port, [5, 1, 0, 5, 2, 0, 1, 1, 2, 3, 4, 0, 80]);
    expect(bind[3]).toBe(7);
    expect(s.requests).toHaveLength(0);
  });

  it('reports a failed upstream connection', async () => {
    const s = await serve(false);
    const reply = await client(s.port, [5, 1, 0, 5, 1, 0, 1, 1, 2, 3, 4, 0, 80]);
    expect(reply[3]).toBe(5);
  });
});
