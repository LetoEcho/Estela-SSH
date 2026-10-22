import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SshSession } from '../../shared/session';
import { SessionStore } from './sessions';

const ssh = (over: Partial<SshSession> = {}): SshSession => ({
  type: 'ssh', id: 's1', name: 'web', folderId: null, color: '#f00', icon: '🖥️',
  host: 'h', port: 22, username: 'u', auth: 'password', ...over,
});

describe('SessionStore', () => {
  let file: string;
  beforeEach(() => {
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'estela-')), 'sessions.json');
  });

  it('persists and reloads sessions and folders', () => {
    const a = new SessionStore(file);
    a.saveFolder({ id: 'f1', name: 'prod', parentId: null });
    a.saveSession(ssh({ folderId: 'f1' }));
    const b = new SessionStore(file);
    expect(b.get().sessions[0]).toMatchObject({ id: 's1', folderId: 'f1' });
    expect(b.get().folders).toHaveLength(1);
  });

  it('upserts by id', () => {
    const st = new SessionStore(file);
    st.saveSession(ssh());
    st.saveSession(ssh({ name: 'renamed' }));
    expect(st.get().sessions.map((s) => s.name)).toEqual(['renamed']);
  });

  it('rejects invalid sessions and unknown folders', () => {
    const st = new SessionStore(file);
    expect(() => st.saveSession({ ...ssh(), port: 70000 })).toThrow(/port/);
    expect(() => st.saveSession(ssh({ auth: 'key' }))).toThrow(/keyPath/);
    expect(() => st.saveSession(ssh({ folderId: 'nope' }))).toThrow(/folder/);
  });

  it('deleting a folder moves its children to the parent', () => {
    const st = new SessionStore(file);
    st.saveFolder({ id: 'root', name: 'r', parentId: null });
    st.saveFolder({ id: 'mid', name: 'm', parentId: 'root' });
    st.saveFolder({ id: 'leaf', name: 'l', parentId: 'mid' });
    st.saveSession(ssh({ folderId: 'mid' }));
    st.deleteFolder('mid');
    expect(st.get().sessions[0].folderId).toBe('root');
    expect(st.get().folders.find((f) => f.id === 'leaf')?.parentId).toBe('root');
  });

  it('prevents folder cycles and jump host loops', () => {
    const st = new SessionStore(file);
    st.saveFolder({ id: 'a', name: 'a', parentId: null });
    st.saveFolder({ id: 'b', name: 'b', parentId: 'a' });
    expect(() => st.saveFolder({ id: 'a', name: 'a', parentId: 'b' })).toThrow(/inside itself/);
    st.saveSession(ssh({ id: 'j1' }));
    st.saveSession(ssh({ id: 'j2', jumpSessionId: 'j1' }));
    expect(() => st.saveSession(ssh({ id: 'j1', jumpSessionId: 'j2' }))).toThrow(/loop/);
  });

  it('deleting a session clears jump references to it', () => {
    const st = new SessionStore(file);
    st.saveSession(ssh({ id: 'j1' }));
    st.saveSession(ssh({ id: 'j2', jumpSessionId: 'j1' }));
    st.deleteSession('j1');
    expect((st.find('j2') as SshSession).jumpSessionId).toBeUndefined();
  });

  it('round-trips export/import and drops dangling references', () => {
    const src = new SessionStore(file);
    src.saveFolder({ id: 'f1', name: 'prod', parentId: null });
    src.saveSession(ssh({ folderId: 'f1', keyPath: '~/.ssh/id', auth: 'key' }));
    const exported = JSON.parse(src.export());
    const other = path.join(path.dirname(file), 'other.json');
    const dst = new SessionStore(other);
    expect(dst.import(exported)).toBe(1);
    expect(dst.get()).toEqual(src.get());

    const broken = { version: 1, folders: [], sessions: [ssh({ id: 'x', folderId: 'gone', jumpSessionId: 'gone' })] };
    dst.import(broken);
    expect(dst.find('x')).toMatchObject({ folderId: null });
    expect((dst.find('x') as SshSession).jumpSessionId).toBeUndefined();
  });

  it('refuses malformed import files', () => {
    const st = new SessionStore(file);
    expect(() => st.import({ version: 2, folders: [], sessions: [] })).toThrow(/version/);
    expect(() => st.import({ version: 1, folders: [], sessions: [{ type: 'telnet' }] })).toThrow(/type/);
  });
});

describe('custom icons', () => {
  const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'estela-')), 'sessions.json');
  const ico = `data:image/x-icon;base64,${Buffer.from('fake-ico').toString('base64')}`;

  it('stores .ico data URLs on folders and sessions and keeps them through export/import', () => {
    const st = new SessionStore(file());
    st.saveFolder({ id: 'f', name: 'f', parentId: null, icon: ico });
    st.saveSession(ssh({ folderId: 'f', icon: ico }));
    const dst = new SessionStore(file());
    dst.import(JSON.parse(st.export()));
    expect(dst.get().folders[0].icon).toBe(ico);
    expect(dst.find('s1')?.icon).toBe(ico);
  });

  it('rejects non-image data URLs and oversized icons', () => {
    const st = new SessionStore(file());
    expect(() => st.saveFolder({ id: 'f', name: 'f', parentId: null, icon: 'data:text/html;base64,PGI+' })).toThrow(/icon/);
    const huge = `data:image/png;base64,${'A'.repeat(800_000)}`;
    expect(() => st.saveFolder({ id: 'f', name: 'f', parentId: null, icon: huge })).toThrow(/512 KB/);
  });
});

describe('RDP sessions and tunnels', () => {
  const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'estela-')), 'sessions.json');
  const rdp = { type: 'rdp', id: 'r1', name: 'win', folderId: null, color: '#fff', icon: '🪟', host: 'srv01', username: 'ana', screen: '1600x900' };

  it('stores RDP sessions with defaults and validates the via-SSH reference', () => {
    const st = new SessionStore(file());
    st.saveSession(ssh({ id: 'bastion' }));
    st.saveSession({ ...rdp, viaSshSessionId: 'bastion' });
    expect(st.find('r1')).toMatchObject({ type: 'rdp', port: 3389, clipboard: true, multimon: false, viaSshSessionId: 'bastion' });
    expect(() => st.saveSession(ssh({ id: 's9', jumpSessionId: 'r1' }))).toThrow(/Only SSH/);
    st.deleteSession('bastion');
    expect(st.find('r1')).not.toHaveProperty('viaSshSessionId');
  });

  it('rejects RDP fields that could smuggle FreeRDP options', () => {
    const st = new SessionStore(file());
    expect(() => st.saveSession({ ...rdp, host: 'srv /drive:x,/' })).toThrow(/host/);
    expect(() => st.saveSession({ ...rdp, screen: '1600x900 /f' })).toThrow(/screen/);
  });

  it('validates tunnels', () => {
    const st = new SessionStore(file());
    st.saveSession(ssh({ tunnels: [{ id: 't', kind: 'L', bindHost: '127.0.0.1', bindPort: 8080, destHost: 'db', destPort: 5432, autoStart: true }] }));
    expect((st.find('s1') as SshSession).tunnels?.[0]).toMatchObject({ kind: 'L', bindPort: 8080 });
    expect(() => st.saveSession(ssh({ tunnels: [{ id: 't', kind: 'L', bindPort: 8080, autoStart: false } as never] }))).toThrow(/destHost/);
    st.saveSession(ssh({ tunnels: [{ id: 'd', kind: 'D', bindHost: '127.0.0.1', bindPort: 1080, autoStart: false }] }));
    expect((st.find('s1') as SshSession).tunnels?.[0]).not.toHaveProperty('destHost');
  });
});

describe('serial sessions', () => {
  const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'estela-')), 'sessions.json');
  const serial = { type: 'serial', id: 'c1', name: 'router', folderId: null, color: '#fff', path: 'COM3', baudRate: 115200 };

  it('fills in the line defaults and keeps the port verbatim', () => {
    const st = new SessionStore(file());
    st.saveSession(serial);
    expect(st.find('c1')).toEqual({
      type: 'serial', id: 'c1', name: 'router', folderId: null, color: '#fff', icon: '🔌',
      path: 'COM3', baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none',
      newline: 'cr', localEcho: false,
    });
  });

  it('stores the line settings it is given', () => {
    const st = new SessionStore(file());
    st.saveSession({ ...serial, dataBits: 7, stopBits: 1.5, parity: 'even', flowControl: 'xonxoff', newline: 'crlf', localEcho: true, log: true });
    expect(st.find('c1')).toMatchObject({ dataBits: 7, stopBits: 1.5, parity: 'even', flowControl: 'xonxoff', newline: 'crlf', localEcho: true, log: true });
  });

  it('rejects impossible line settings', () => {
    const st = new SessionStore(file());
    expect(() => st.saveSession({ ...serial, baudRate: 0 })).toThrow(/baudRate/);
    expect(() => st.saveSession({ ...serial, baudRate: 9600.5 })).toThrow(/baudRate/);
    expect(() => st.saveSession({ ...serial, dataBits: 9 })).toThrow(/dataBits/);
    expect(() => st.saveSession({ ...serial, stopBits: 3 })).toThrow(/stopBits/);
    expect(() => st.saveSession({ ...serial, parity: 'weird' })).toThrow(/parity/);
    expect(() => st.saveSession({ ...serial, flowControl: 'both' })).toThrow(/flowControl/);
    expect(() => st.saveSession({ ...serial, newline: 'lfcr' })).toThrow(/newline/);
    expect(() => st.saveSession({ ...serial, path: '' })).toThrow(/path/);
  });

  it('cannot be used as a jump host and survives export/import', () => {
    const st = new SessionStore(file());
    st.saveSession(serial);
    expect(() => st.saveSession(ssh({ id: 's9', jumpSessionId: 'c1' }))).toThrow(/Only SSH/);
    const dst = new SessionStore(file());
    dst.import(JSON.parse(st.export()));
    expect(dst.find('c1')).toEqual(st.find('c1'));
  });
});
