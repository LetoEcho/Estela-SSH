// An ssh2 server backed by real local programs: an interactive bash in a pty (via `script`),
// `bash -c` for exec, and OpenSSH's sftp-server. Lets tests exercise the shell hook and SFTP
// against real software without Docker. Also runnable by hand: `npm run test-server`.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Server, utils, type ServerChannel } from 'ssh2';

export const SFTP_SERVER = ['/usr/lib/openssh/sftp-server', '/usr/libexec/openssh/sftp-server', '/usr/lib/ssh/sftp-server'].find((p) =>
  fs.existsSync(p),
);
export const HAS_SCRIPT = fs.existsSync('/usr/bin/script');

export interface RealServer {
  port: number;
  /** Home of the fake user: a temp dir the shells start in. */
  home: string;
  close(): void;
}

/** `shell` is the login shell to emulate, e.g. '/bin/sh' to exercise the /proc fallback. */
export function startRealServer(port = 0, shell = '/bin/bash', hostKey = utils.generateKeyPairSync('ed25519').private): Promise<RealServer> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'estela-home-'));
  const env = { ...process.env, HOME: home, SHELL: shell, HISTFILE: path.join(home, '.bash_history'), PS1: 'test$ ' };
  const pipe = (ch: ServerChannel, cmd: string, args: string[]) => {
    const p = spawn(cmd, args, { cwd: home, env });
    ch.pipe(p.stdin);
    p.stdout.pipe(ch);
    p.stderr.pipe(ch.stderr);
    p.on('exit', (code) => {
      ch.exit(code ?? 0);
      ch.end();
    });
    ch.on('close', () => p.kill());
  };

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) =>
      ctx.method === 'password' && ctx.password === 'secret' ? ctx.accept() : ctx.reject(['password']),
    );
    client.on('ready', () => {
      // Port forwarding, so tunnels and jump hosts can be tested too.
      client.on('tcpip', (accept, reject, info) => {
        const sock = net.connect(info.destPort, info.destIP, () => {
          const ch = accept();
          ch.pipe(sock).pipe(ch);
        });
        sock.on('error', () => reject());
      });
      client.on('request', (accept, reject, name, info) => {
        if (name !== 'tcpip-forward') return reject?.();
        const fwd = info as { bindAddr: string; bindPort: number };
        // Like OpenSSH, announce the real port (it differs from the requested one when that was 0).
        const srv = net.createServer((sock) =>
          client.forwardOut(fwd.bindAddr, (srv.address() as net.AddressInfo).port, sock.remoteAddress ?? '', sock.remotePort ?? 0, (err, ch) =>
            err ? sock.destroy() : sock.pipe(ch).pipe(sock),
          ),
        );
        srv.listen(fwd.bindPort, fwd.bindAddr, () => accept?.((srv.address() as net.AddressInfo).port));
        client.once('close', () => srv.close());
      });
      client.on('session', (accept) => {
        const s = accept();
        s.on('pty', (ok) => ok?.());
        s.on('window-change', (ok) => ok?.());
        s.on('shell', (ok) => pipe(ok(), 'script', ['-qfec', shell.endsWith('bash') ? `${shell} --norc -i` : `${shell} -i`, '/dev/null']));
        s.on('exec', (ok, _rej, info) => pipe(ok(), 'bash', ['-c', info.command]));
        (s as unknown as NodeJS.EventEmitter).on('subsystem', (ok: () => ServerChannel, rej: () => void, info: { name: string }) =>
          info.name === 'sftp' && SFTP_SERVER ? pipe(ok(), SFTP_SERVER, []) : rej(),
        );
      });
    });
    client.on('error', () => {});
  });
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () =>
      resolve({
        port: (server.address() as net.AddressInfo).port,
        home,
        close: () => {
          server.close();
          fs.rmSync(home, { recursive: true, force: true });
        },
      }),
    ),
  );
}

if (process.argv[1]?.endsWith('test-server.js')) {
  void startRealServer(Number(process.env['PORT'] ?? 2222), process.env['TEST_SHELL']).then((s) =>
    console.log(`Test SSH server on 127.0.0.1:${s.port} (user: any, password: secret, home: ${s.home}, shell: ${process.env['TEST_SHELL'] ?? '/bin/bash'})`),
  );
}
