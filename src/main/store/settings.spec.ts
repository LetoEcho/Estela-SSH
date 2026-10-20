import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, validateSettings } from './settings';

describe('validateSettings', () => {
  it('fills defaults for missing or old files', () => {
    expect(validateSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(validateSettings({ editor: 'external', externalEditor: 'gedit' })).toEqual({ ...DEFAULT_SETTINGS, editor: 'external', externalEditor: 'gedit' });
  });

  it('clamps numbers and rejects wrong types', () => {
    const s = validateSettings({ fontSize: 99, scrollback: 10, keepaliveSec: -5, theme: 'neon', copyOnSelect: 'yes', fontFamily: 42 });
    expect(s).toMatchObject({ fontSize: 32, scrollback: 1000, keepaliveSec: 0, theme: 'system', copyOnSelect: true, fontFamily: DEFAULT_SETTINGS.fontFamily });
  });
});
