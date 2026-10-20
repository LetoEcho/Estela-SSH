import { describe, expect, it } from 'vitest';
import type { SshSession } from '../../shared/session';
import { resolveHost, parseSshConfig, sessionsFromSshConfig } from './ssh-config';

const CONFIG = `
# global defaults
ServerAliveInterval 30

Host bastion
  HostName bastion.corp.example
  User jump
  IdentityFile ~/.ssh/id_corp

Host web? db01
  HostName %h.internal
  ProxyJump bastion

Host legacy
  HostName=10.0.0.5
  Port 2222
  ProxyJump ops@gw1.example:2200,bastion

Host *.dev !secret.dev
  User dev

Host *
  User fallback
  Port 22
`;

let n = 0;
const opts = (existing: SshSession[] = []) => ({ existing, defaultUser: 'me', hasAgent: true, folderId: 'f', newId: () => `id${++n}` });
const find = (list: SshSession[], name: string) => list.find((s) => s.name === name)!;

describe('ssh config', () => {
  it('resolves options with first-match-wins semantics', () => {
    const blocks = parseSshConfig(CONFIG);
    expect(Object.fromEntries(resolveHost(blocks, 'bastion'))).toMatchObject({ hostname: 'bastion.corp.example', user: 'jump' });
    expect(resolveHost(blocks, 'x.dev').get('user')).toBe('dev');
    expect(resolveHost(blocks, 'secret.dev').get('user')).toBe('fallback');
    expect(resolveHost(blocks, 'legacy').get('port')).toBe('2222');
  });

  it('creates sessions with auth, jump chains and hop sessions', () => {
    const list = sessionsFromSshConfig(CONFIG, opts());
    const bastion = find(list, 'bastion');
    expect(bastion).toMatchObject({ host: 'bastion.corp.example', username: 'jump', auth: 'key', keyPath: '~/.ssh/id_corp' });
    expect(find(list, 'db01')).toMatchObject({ host: 'db01.internal', username: 'fallback', auth: 'agent', jumpSessionId: bastion.id });
    // web? is a pattern, not a host
    expect(list.some((s) => s.name.startsWith('web'))).toBe(false);
    // legacy: gw1 first, then bastion, then legacy
    const gw = find(list, 'ops@gw1.example:2200');
    expect(gw).toMatchObject({ host: 'gw1.example', port: 2200, username: 'ops' });
    expect(find(list, 'legacy')).toMatchObject({ host: '10.0.0.5', port: 2222, jumpSessionId: bastion.id });
    expect(bastion.jumpSessionId).toBe(gw.id);
  });

  it('skips hosts that already exist and reuses them as jump hosts', () => {
    const existing: SshSession = {
      type: 'ssh', id: 'old', name: 'mine', folderId: null, color: '', icon: '', host: 'bastion.corp.example', port: 22, username: 'jump', auth: 'password',
    };
    const list = sessionsFromSshConfig(CONFIG, opts([existing]));
    expect(list.some((s) => s.name === 'bastion')).toBe(false);
    expect(find(list, 'db01').jumpSessionId).toBe('old');
  });
});
