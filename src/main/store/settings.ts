import type { Settings } from '../../shared/ipc';
import { readJson, writeAtomic } from './fs-util';

const DEFAULTS: Settings = { editor: 'internal', externalEditor: 'code' };

export function validateSettings(x: unknown): Settings {
  const o = (typeof x === 'object' && x !== null ? x : {}) as Record<string, unknown>;
  const editor = o['editor'] === 'external' ? 'external' : 'internal';
  const ext = typeof o['externalEditor'] === 'string' ? o['externalEditor'].trim().slice(0, 500) : DEFAULTS.externalEditor;
  return { editor, externalEditor: ext || DEFAULTS.externalEditor };
}

export class SettingsStore {
  private data: Settings;

  constructor(private readonly file: string) {
    this.data = validateSettings(readJson(file) ?? DEFAULTS);
  }

  get(): Settings {
    return { ...this.data };
  }

  set(x: unknown): void {
    this.data = validateSettings(x);
    writeAtomic(this.file, JSON.stringify(this.data, null, 2));
  }
}
