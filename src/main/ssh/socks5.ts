import type { Duplex } from 'node:stream';

// Minimal SOCKS5 server side (RFC 1928): no authentication, CONNECT only. Enough for browsers and curl.

export interface SocksRequest {
  host: string;
  port: number;
  /** Bytes the client sent after the request (normally none). */
  leftover: Buffer;
  /** Sends the final reply; on failure the socket is closed. */
  reply(ok: boolean): void;
}

/** Reads exactly n bytes, keeping what arrives early. */
function byteReader(sock: Duplex) {
  let buf = Buffer.alloc(0);
  let wake: (() => void) | null = null;
  let ended = false;
  const onData = (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    wake?.();
  };
  const onEnd = () => {
    ended = true;
    wake?.();
  };
  sock.on('data', onData);
  sock.once('end', onEnd);
  sock.once('close', onEnd);
  return {
    async take(n: number): Promise<Buffer> {
      while (buf.length < n) {
        if (ended) throw new Error('SOCKS client went away');
        await new Promise<void>((r) => (wake = r));
        wake = null;
      }
      const out = buf.subarray(0, n);
      buf = buf.subarray(n);
      return out;
    },
    /** Stops reading and returns anything not consumed yet. */
    detach(): Buffer {
      sock.removeListener('data', onData);
      sock.removeListener('end', onEnd);
      sock.removeListener('close', onEnd);
      sock.pause();
      return buf;
    },
  };
}

export async function acceptSocks5(sock: Duplex): Promise<SocksRequest> {
  const r = byteReader(sock);
  const fail = (code: number) => {
    sock.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]));
    return new Error(`SOCKS request rejected (${code})`);
  };
  const [ver, nMethods] = await r.take(2);
  if (ver !== 5) throw (sock.destroy(), new Error('Not a SOCKS5 client'));
  const methods = await r.take(nMethods);
  if (!methods.includes(0)) {
    sock.end(Buffer.from([5, 0xff]));
    throw new Error('SOCKS client requires authentication');
  }
  sock.write(Buffer.from([5, 0]));

  const [, cmd, , atyp] = await r.take(4);
  if (cmd !== 1) throw fail(7); // command not supported
  let host: string;
  if (atyp === 1) host = [...(await r.take(4))].join('.');
  else if (atyp === 3) host = (await r.take((await r.take(1))[0])).toString('utf8');
  else if (atyp === 4) host = formatIPv6(await r.take(16));
  else throw fail(8); // address type not supported
  const port = (await r.take(2)).readUInt16BE(0);
  const leftover = r.detach();
  return {
    host,
    port,
    leftover,
    reply(ok) {
      if (ok) sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
      else fail(5); // connection refused
    },
  };
}

function formatIPv6(b: Buffer): string {
  const parts: string[] = [];
  for (let i = 0; i < 16; i += 2) parts.push(b.readUInt16BE(i).toString(16));
  return parts.join(':');
}
