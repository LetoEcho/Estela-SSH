import { describe, expect, it } from 'vitest';
import type { RdpSession } from '../../shared/session';
import { mstscCredTarget, mstscFile } from './mstsc-file';

const s = (over: Partial<RdpSession> = {}): RdpSession => ({
  type: 'rdp', id: 'r', name: 'Servidor Win', folderId: null, color: '#fff', icon: 'x',
  host: 'srv01.corp', port: 3389, username: 'ana', screen: 'fullscreen',
  multimon: false, clipboard: true, drives: false, ...over,
});

describe('mstscFile', () => {
  it('builds a fullscreen connection without any password', () => {
    const f = mstscFile(s(), { host: 'srv01.corp', port: 3389 }, 'C:\\');
    expect(f.split('\r\n')).toEqual([
      'full address:s:srv01.corp:3389',
      'username:s:ana',
      'prompt for credentials:i:0',
      'authentication level:i:2',
      'screen mode id:i:2',
      'use multimon:i:0',
      'redirectclipboard:i:1',
      '',
    ]);
    expect(f).not.toMatch(/password/i);
  });

  it('maps window size, domain, drives, gateway and a tunnel target', () => {
    const f = mstscFile(
      s({ screen: '1280x720', domain: 'CORP', drives: true, clipboard: false, multimon: true, gateway: 'gw.corp:443' }),
      { host: '127.0.0.1', port: 50123 },
      'D:\\',
    );
    expect(f).toContain('full address:s:127.0.0.1:50123\r\n');
    expect(f).toContain('username:s:CORP\\ana\r\n');
    expect(f).toContain('screen mode id:i:1\r\ndesktopwidth:i:1280\r\ndesktopheight:i:720\r\n');
    expect(f).toContain('use multimon:i:1\r\nredirectclipboard:i:0\r\ndrivestoredirect:s:D:\\;\r\n');
    expect(f).toContain('gatewayhostname:s:gw.corp:443\r\ngatewayusagemethod:i:1\r\n');
  });

  it('targets the credential mstsc looks up', () => {
    expect(mstscCredTarget('srv01.corp')).toBe('TERMSRV/srv01.corp');
  });
});
