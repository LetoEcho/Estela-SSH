import { describe, expect, it } from 'vitest';
import { keyAction, keyId } from './keymap';

const ev = (key: string, mods: Partial<KeyboardEvent> = {}) =>
  ({ key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods }) as KeyboardEvent;

describe('keymap', () => {
  it('normalises modifiers and key case', () => {
    expect(keyId(ev('C', { ctrlKey: true, shiftKey: true }))).toBe('ctrl+shift+c');
  });
  it('maps Linux terminal shortcuts and leaves plain Ctrl+C to the shell', () => {
    expect(keyAction('linux', ev('C', { ctrlKey: true, shiftKey: true }))).toBe('copy');
    expect(keyAction('linux', ev('c', { ctrlKey: true }))).toBeUndefined();
  });
});
