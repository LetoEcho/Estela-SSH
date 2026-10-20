import type { Settings } from '../../shared/ipc';
import { validateSettings } from '../../shared/settings';
import { readJson, writeAtomic } from './fs-util';

export { DEFAULT_SETTINGS, validateSettings } from '../../shared/settings';

export class SettingsStore {
  private data: Settings;

  constructor(private readonly file: string) {
    this.data = validateSettings(readJson(file) ?? {});
  }

  get(): Settings {
    return { ...this.data };
  }

  set(x: unknown): Settings {
    this.data = validateSettings(x);
    writeAtomic(this.file, JSON.stringify(this.data, null, 2));
    return this.get();
  }
}
