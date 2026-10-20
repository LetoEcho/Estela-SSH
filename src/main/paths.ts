import os from 'node:os';
import path from 'node:path';

// Local paths only (OS separators). Remote paths always use path.posix.

/** "~/x" → absolute; keeps session files portable between machines and OSes. */
export function expandHome(p: string, home = os.homedir()): string {
  return p === '~' ? home : p.startsWith('~/') || p.startsWith('~\\') ? path.join(home, p.slice(2)) : p;
}

/** Absolute path under home → "~/x" with forward slashes. */
export function collapseHome(p: string, home = os.homedir()): string {
  const rel = path.relative(home, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? `~/${rel.split(path.sep).join('/')}` : p;
}

/**
 * Remote file name → valid local file name. Windows forbids <>:"/\|?* and control characters,
 * trailing dots/spaces and device names (CON, NUL, COM1…); those get replaced or prefixed with "_".
 */
export function localName(name: string, windows = path.sep === '\\'): string {
  if (!windows) return name;
  const n = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, (m) => '_'.repeat(m.length));
  return /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n) ? `_${n}` : n;
}
