import { Injectable, computed, effect, signal } from '@angular/core';
import type { Settings } from '../../shared/ipc';
import { DEFAULT_SETTINGS } from '../../shared/settings';
import { estela } from './estela';

/** App settings as signals; also applies the colour theme to the document. */
@Injectable({ providedIn: 'root' })
export class SettingsService {
  readonly value = signal<Settings>(DEFAULT_SETTINGS);
  private readonly media = window.matchMedia('(prefers-color-scheme: dark)');
  private readonly systemDark = signal(this.media.matches);
  readonly theme = computed<'dark' | 'light'>(() => {
    const t = this.value().theme;
    return t === 'system' ? (this.systemDark() ? 'dark' : 'light') : t;
  });

  constructor() {
    this.media.addEventListener('change', (e) => this.systemDark.set(e.matches));
    void estela.invoke('settings:get').then((s) => this.value.set(s));
    effect(() => (document.documentElement.dataset['theme'] = this.theme()));
  }

  async save(s: Settings): Promise<void> {
    this.value.set(await estela.invoke('settings:set', s));
  }
}
