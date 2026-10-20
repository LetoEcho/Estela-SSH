import type { Settings } from './ipc';

export const DEFAULT_SETTINGS: Settings = {
  editor: 'internal',
  externalEditor: 'code',
  theme: 'system',
  fontFamily: '"DejaVu Sans Mono", "Liberation Mono", monospace',
  fontSize: 14,
  scrollback: 10_000,
  copyOnSelect: true,
  rightClickPaste: true,
  keepaliveSec: 30,
  autoReconnect: false,
  logDir: '',
};

const clampInt = (v: unknown, min: number, max: number, def: number) =>
  Number.isInteger(v) ? Math.min(max, Math.max(min, v as number)) : def;
const text = (v: unknown, max: number, def: string) => (typeof v === 'string' ? v.trim().slice(0, max) : def);
const bool = (v: unknown, def: boolean) => (typeof v === 'boolean' ? v : def);

/** Coerces anything (old files, renderer input) into valid settings, keeping defaults for bad values. */
export function validateSettings(x: unknown): Settings {
  const o = (typeof x === 'object' && x !== null ? x : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  return {
    editor: o['editor'] === 'external' ? 'external' : 'internal',
    externalEditor: text(o['externalEditor'], 500, d.externalEditor) || d.externalEditor,
    theme: o['theme'] === 'dark' || o['theme'] === 'light' ? o['theme'] : 'system',
    fontFamily: text(o['fontFamily'], 200, d.fontFamily) || d.fontFamily,
    fontSize: clampInt(o['fontSize'], 8, 32, d.fontSize),
    scrollback: clampInt(o['scrollback'], 1_000, 200_000, d.scrollback),
    copyOnSelect: bool(o['copyOnSelect'], d.copyOnSelect),
    rightClickPaste: bool(o['rightClickPaste'], d.rightClickPaste),
    keepaliveSec: clampInt(o['keepaliveSec'], 0, 600, d.keepaliveSec),
    autoReconnect: bool(o['autoReconnect'], d.autoReconnect),
    logDir: text(o['logDir'], 1000, ''),
  };
}
