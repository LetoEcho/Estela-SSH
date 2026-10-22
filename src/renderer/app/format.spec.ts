import { describe, expect, it } from 'vitest';
import type { SerialSession, SshSession } from '../../shared/session';
import { formatMode, formatSize, sessionTarget } from './format';

const base = { id: 'i', name: 'n', folderId: null, color: '#fff', icon: '🖥️' };

describe('format', () => {
  it('session target', () => {
    const ssh = { ...base, type: 'ssh', host: 'srv', port: 2222, username: 'ana', auth: 'password' } satisfies SshSession;
    expect(sessionTarget(ssh)).toBe('ana@srv');
    expect(sessionTarget(ssh, true)).toBe('ana@srv:2222');
    const serial = {
      ...base,
      type: 'serial',
      path: 'COM3',
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
      newline: 'cr',
      localEcho: false,
    } satisfies SerialSession;
    expect(sessionTarget(serial)).toBe('COM3');
    expect(sessionTarget(serial, true)).toBe('COM3 · 115200 bd');
  });

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
