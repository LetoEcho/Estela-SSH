import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { SecretStore, type Cipher } from './secrets';

// Reversible fake: never plain text on disk, so the "not plain" assertion is meaningful.
const cipher: Cipher = {
  encryptString: (s) => Buffer.from(s, 'utf8').reverse(),
  decryptString: (b) => Buffer.from(b).reverse().toString('utf8'),
};

describe('SecretStore', () => {
  let file: string;
  beforeEach(() => {
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'estela-')), 'secrets.json');
  });

  it('encrypts on disk and decrypts on read', () => {
    const st = new SecretStore(file, cipher, { name: 'gnome_libsecret', secure: true });
    st.set('s1', 'password', 'hunter2');
    expect(fs.readFileSync(file, 'utf8')).not.toContain('hunter2');
    expect(new SecretStore(file, cipher, { name: 'x', secure: true }).get('s1', 'password')).toBe('hunter2');
    // Windows has no POSIX modes; the file lives in the user's profile instead.
    if (process.platform !== 'win32') expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
  });

  it('refuses to store without a keyring until accepted', () => {
    const st = new SecretStore(file, cipher, { name: 'basic_text', secure: false });
    expect(st.canStore()).toBe(false);
    expect(() => st.set('s1', 'password', 'x')).toThrow(/keyring/);
    st.acceptInsecure();
    st.set('s1', 'password', 'x');
    expect(st.status()).toEqual({ backend: 'basic_text', secure: false, acceptedInsecure: true });
  });

  it('deletes single secrets and all secrets of a session', () => {
    const st = new SecretStore(file, cipher, { name: 'k', secure: true });
    st.set('s1', 'password', 'a');
    st.set('s1', 'passphrase', 'b');
    st.set('s2', 'password', 'c');
    st.set('s1', 'password', null);
    expect(st.has('s1', 'password')).toBe(false);
    st.deleteSession('s1');
    expect(st.has('s1', 'passphrase')).toBe(false);
    expect(st.get('s2', 'password')).toBe('c');
  });

  it('treats undecryptable entries as missing', () => {
    const st = new SecretStore(file, cipher, { name: 'k', secure: true });
    st.set('s1', 'password', 'a');
    const broken = new SecretStore(file, { ...cipher, decryptString: () => { throw new Error('keyring changed'); } }, { name: 'k', secure: true });
    expect(broken.get('s1', 'password')).toBeUndefined();
  });
});
