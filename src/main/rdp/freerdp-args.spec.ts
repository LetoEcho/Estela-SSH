import { describe, expect, it } from 'vitest';
import type { RdpSession } from '../../shared/session';
import { freerdpArgs } from './freerdp-args';

const s = (over: Partial<RdpSession> = {}): RdpSession => ({
  type: 'rdp', id: 'r', name: 'Servidor Win', folderId: null, color: '#fff', icon: 'x',
  host: 'srv01.corp', port: 3389, username: 'ana', screen: 'fullscreen',
  multimon: false, clipboard: true, drives: false, ...over,
});

describe('freerdpArgs', () => {
  it('builds a minimal fullscreen connection without the password', () => {
    const args = freerdpArgs(s(), { host: 'srv01.corp', port: 3389 });
    expect(args).toEqual(['/v:srv01.corp:3389', '/u:ana', '/from-stdin:force', '/t:Servidor Win', '/f', '/log-level:WARN']);
    expect(args.join(' ')).not.toMatch(/\/p:/);
  });

  it('maps every option', () => {
    const args = freerdpArgs(
      s({ domain: 'CORP', screen: '1600x900', multimon: true, clipboard: false, drives: true, gateway: 'gw.corp:443' }),
      { host: 'srv01.corp', port: 3389 },
    );
    expect(args).toEqual(expect.arrayContaining(['/d:CORP', '/size:1600x900', '/multimon', '-clipboard', '+home-drive', '/gateway:g:gw.corp:443']));
    expect(args).not.toContain('/f');
  });

  it('passes a domain-qualified user name as one argument and adds no second domain', () => {
    // spawn() gets an array, so the backslash (and anything else) stays inside its own argv token.
    const args = freerdpArgs(s({ username: 'DOMINIO\\ana', domain: 'CORP' }), { host: 'srv01.corp', port: 3389 });
    expect(args).toContain('/u:DOMINIO\\ana');
    expect(args.some((a) => a.startsWith('/d:'))).toBe(false);
  });

  it('targets the local tunnel and pins the trusted certificate', () => {
    const fp = 'a6:ee:0b:74:6d:89:90:56:ef:21:e9:36:bb:6c:34:71:73:bb:2c:45:9c:26:ea:81:0e:bf:4f:8b:8d:2e:1b:26';
    const args = freerdpArgs(s(), { host: '127.0.0.1', port: 50123, thumbprint: fp });
    expect(args[0]).toBe('/v:127.0.0.1:50123');
    expect(args).toContain(`/cert:fingerprint:sha256:${fp}`);
  });
});
