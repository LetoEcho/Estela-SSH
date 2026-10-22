import type { Session } from '../../shared/session';

/** What a session connects to: user@host, or the port of a serial line. `full` adds the port / speed, for tooltips. */
export function sessionTarget(s: Session, full = false): string {
  if (s.type === 'serial') return full ? `${s.path} · ${s.baudRate} bd` : s.path;
  return full ? `${s.username}@${s.host}:${s.port}` : `${s.username}@${s.host}`;
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = -1;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** "drwxr-xr-x" style string. */
export function formatMode(mode: number, isDir: boolean, isLink = false): string {
  const t = isLink ? 'l' : isDir ? 'd' : '-';
  const rwx = (b: number) => `${b & 4 ? 'r' : '-'}${b & 2 ? 'w' : '-'}${b & 1 ? 'x' : '-'}`;
  return t + rwx(mode >> 6) + rwx(mode >> 3) + rwx(mode);
}
