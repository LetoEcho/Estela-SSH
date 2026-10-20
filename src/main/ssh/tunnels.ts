import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { Client } from 'ssh2';
import type { TunnelStatus } from '../../shared/ipc';
import type { Tunnel } from '../../shared/session';
import type { SshConnection } from './connection';
import { acceptSocks5 } from './socks5';

/** Connects two streams both ways; an error or end on either side tears both down. */
export function splice(a: Duplex, b: Duplex): void {
  const kill = () => {
    a.destroy();
    b.destroy();
  };
  a.on('error', kill);
  b.on('error', kill);
  a.pipe(b).pipe(a);
}

const forwardOut = (client: Client, src: net.Socket, host: string, port: number) =>
  new Promise<Duplex>((resolve, reject) =>
    client.forwardOut(src.remoteAddress ?? '127.0.0.1', src.remotePort ?? 0, host, port, (err, ch) => (err ? reject(err) : resolve(ch))),
  );

function listen(server: net.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}

interface Running {
  conn: SshConnection;
  server?: net.Server;
}

/**
 * Runs SSH tunnels. Each tunnel owns its SSH connection, so stopping one never disturbs a terminal.
 * ponytail: one connection per tunnel; share per session if someone runs dozens of them.
 */
export class TunnelManager {
  private running = new Map<string, Running>();
  private states = new Map<string, TunnelStatus>();

  constructor(
    private readonly newConnection: () => SshConnection,
    private readonly emit: (s: TunnelStatus) => void,
  ) {}

  list(): TunnelStatus[] {
    return [...this.states.values()];
  }

  async start(sessionId: string, t: Tunnel): Promise<void> {
    if (this.running.has(t.id)) return;
    const conn = this.newConnection();
    const r: Running = { conn };
    this.running.set(t.id, r);
    this.set({ sessionId, tunnelId: t.id, state: 'starting' });
    try {
      const client = await conn.connect(sessionId);
      const port = await this.open(client, t, r);
      if (!this.running.has(t.id)) return void conn.close(); // stopped while connecting
      conn.onDrop(() => this.fail(sessionId, t.id, conn.lastError ?? 'Conexión SSH perdida'));
      this.set({ sessionId, tunnelId: t.id, state: 'running', port });
    } catch (e) {
      this.fail(sessionId, t.id, e instanceof Error ? e.message : String(e));
    }
  }

  stop(tunnelId: string): void {
    const r = this.running.get(tunnelId);
    this.running.delete(tunnelId);
    r?.server?.close();
    r?.conn.close();
    const s = this.states.get(tunnelId);
    if (s) this.set({ ...s, state: 'stopped', error: undefined, port: undefined });
  }

  stopAll(): void {
    for (const id of [...this.running.keys()]) this.stop(id);
  }

  /**
   * An untracked local forward on a free port, for RDP over SSH.
   * Returns the port and a function that tears it down.
   */
  async ephemeral(sessionId: string, destHost: string, destPort: number): Promise<{ port: number; close(): void }> {
    const conn = this.newConnection();
    try {
      const client = await conn.connect(sessionId);
      const r: Running = { conn };
      const port = await this.open(client, { id: '', kind: 'L', bindHost: '127.0.0.1', bindPort: 0, destHost, destPort, autoStart: false }, r);
      return { port, close: () => (r.server?.close(), conn.close()) };
    } catch (e) {
      conn.close();
      throw e;
    }
  }

  private async open(client: Client, t: Tunnel, r: Running): Promise<number> {
    if (t.kind === 'R') {
      const port = await new Promise<number>((resolve, reject) =>
        client.forwardIn(t.bindHost, t.bindPort, (err, p) => (err ? reject(err) : resolve(p || t.bindPort))),
      );
      client.on('tcp connection', (_info, accept) => {
        const local = net.connect(t.destPort!, t.destHost!);
        splice(local, accept());
      });
      return port;
    }
    const server = (r.server = net.createServer((sock) => {
      sock.on('error', () => sock.destroy());
      if (t.kind === 'L') {
        forwardOut(client, sock, t.destHost!, t.destPort!).then((ch) => splice(sock, ch), () => sock.destroy());
        return;
      }
      acceptSocks5(sock).then(
        (req) =>
          forwardOut(client, sock, req.host, req.port).then(
            (ch) => {
              req.reply(true);
              if (req.leftover.length) ch.write(req.leftover);
              splice(sock, ch);
            },
            () => req.reply(false),
          ),
        () => sock.destroy(),
      );
    }));
    return listen(server, t.bindPort, t.bindHost);
  }

  private fail(sessionId: string, tunnelId: string, error: string): void {
    const r = this.running.get(tunnelId);
    this.running.delete(tunnelId);
    r?.server?.close();
    r?.conn.close();
    this.set({ sessionId, tunnelId, state: 'error', error });
  }

  private set(s: TunnelStatus): void {
    this.states.set(s.tunnelId, s);
    this.emit(s);
  }
}
