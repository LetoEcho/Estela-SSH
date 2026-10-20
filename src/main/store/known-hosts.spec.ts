import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { utils } from 'ssh2';
import { describe, expect, it } from 'vitest';
import { fingerprint, hostId, keyType, KnownHosts } from './known-hosts';

const blob = () => utils.parseKey(utils.generateKeyPairSync('ed25519').public) as { getPublicSSH(): Buffer };

describe('KnownHosts', () => {
  const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'estela-')), 'known_hosts');

  it('uses OpenSSH host notation', () => {
    expect(hostId('h', 22)).toBe('h');
    expect(hostId('h', 2222)).toBe('[h]:2222');
  });

  it('reports unknown, match and changed', () => {
    const kh = new KnownHosts(file());
    const k1 = blob().getPublicSSH();
    const k2 = blob().getPublicSSH();
    expect(kh.check('h', 22, k1).result).toBe('unknown');
    kh.add('h', 22, k1);
    expect(kh.check('h', 22, k1).result).toBe('match');
    expect(kh.check('h', 2222, k1).result).toBe('unknown');
    expect(kh.check('h', 22, k2)).toEqual({ result: 'changed', oldFingerprint: fingerprint(k1) });
    kh.add('h', 22, k2);
    expect(kh.check('h', 22, k2).result).toBe('match');
    expect(kh.check('h', 22, k1).result).toBe('changed');
  });

  it('writes OpenSSH lines and reads foreign files', () => {
    const f = file();
    const k = blob().getPublicSSH();
    fs.writeFileSync(f, `# comment\n|1|hashed|entry ssh-rsa AAAA\nother,h ${keyType(k)} ${k.toString('base64')}\n`);
    const kh = new KnownHosts(f);
    expect(kh.check('h', 22, k).result).toBe('match');
    expect(keyType(k)).toBe('ssh-ed25519');
    expect(fingerprint(k)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });
});
