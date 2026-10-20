import fs from 'node:fs';
import path from 'node:path';

// CSI, OSC (BEL or ST terminated), single-char escapes, and stray control chars except \t \n.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f]/g;

/** Terminal output → readable text: escapes removed, CRLF/CR folded into LF. */
export function stripAnsi(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(ANSI, (m) => (m === '\r' ? '' : m === '\n' ? m : ''));
}

/** Index where an unfinished escape sequence starts at the end of `data` (or data.length if none). */
export function unfinishedEscape(data: string): number {
  // An OSC (title, cwd…) runs until BEL or ESC \ and may itself contain the split point.
  const osc = data.lastIndexOf('\x1b]');
  if (osc >= 0 && data.length - osc <= 4096) {
    const body = data.slice(osc + 2);
    if (!body.includes('\x07') && !body.includes('\x1b\\')) return osc;
  }
  const esc = data.lastIndexOf('\x1b');
  if (esc < 0) return data.length;
  const rest = data.slice(esc);
  if (rest.length === 1) return esc;
  if (rest[1] === '[') return /^\x1b\[[0-?]*[ -/]*[@-~]/.test(rest) ? data.length : esc;
  return data.length;
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const safe = (name: string) => name.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'session';

/** Appends a session's output to `<dir>/<name>-<yyyymmdd-hhmmss>.log`. */
export class SessionLog {
  readonly file: string;
  private out: fs.WriteStream;
  private pending = '';

  constructor(dir: string, name: string, now = new Date()) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${safe(name)}-${stamp(now)}.log`);
    this.out = fs.createWriteStream(this.file, { flags: 'a', mode: 0o600 });
  }

  write(chunk: string): void {
    // An escape sequence can be split across chunks: keep an unfinished tail for the next one.
    const data = this.pending + chunk;
    const cut = unfinishedEscape(data);
    this.pending = data.slice(cut);
    this.out.write(stripAnsi(data.slice(0, cut)));
  }

  close(): void {
    this.out.end(stripAnsi(this.pending));
  }
}
