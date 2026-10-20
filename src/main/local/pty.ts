import os from 'node:os';
import { spawn, type IPty } from 'node-pty';
import type { ShellEvents } from '../ssh/connection';
import { platform } from '../platform';

/** A local shell in a pseudo-terminal; same surface as SshShell for the renderer. */
export class LocalPty {
  private proc?: IPty;
  private closed = false;

  constructor(private readonly events: ShellEvents) {}

  open(shellPath: string, cols: number, rows: number, hookDir: string): void {
    try {
      const s = platform.localShellSpawn(shellPath, hookDir);
      const proc = (this.proc = spawn(s.file, s.args, { name: 'xterm-256color', cols, rows, cwd: os.homedir(), env: s.env }));
      proc.onData((d) => this.events.data(d));
      proc.onExit(({ exitCode }) => {
        if (!this.closed) this.events.status(exitCode === 0 ? 'closed' : 'error', exitCode === 0 ? undefined : `exit ${exitCode}`);
        this.closed = true;
      });
      this.events.status('connected');
      // No typing needed: the rc file installs the hook. The pid enables the /proc fallback.
      this.events.hook({ installed: s.osc7, pid: proc.pid });
    } catch (e) {
      this.events.status('error', e instanceof Error ? e.message : String(e));
    }
  }

  write(data: string): void {
    this.proc?.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.closed) this.proc?.resize(cols, rows);
  }

  retryHook(): void {}

  async cwd(): Promise<string | null> {
    return this.proc ? platform.processCwd(this.proc.pid) : null;
  }

  close(): void {
    this.closed = true;
    this.proc?.kill();
  }
}
