import { describe, expect, it } from 'vitest';
import { formatMode, formatSize } from './format';

describe('format', () => {
  it('sizes', () => {
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(1536)).toBe('1.5 KB');
    expect(formatSize(50 * 1024 * 1024)).toBe('50 MB');
  });
  it('modes', () => {
    expect(formatMode(0o755, true)).toBe('drwxr-xr-x');
    expect(formatMode(0o640, false)).toBe('-rw-r-----');
    expect(formatMode(0o777, false, true)).toBe('lrwxrwxrwx');
  });
});
