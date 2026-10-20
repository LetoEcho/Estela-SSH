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
    expect(st.find('j2')?.jumpSessionId).toBeUndefined();
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
    expect(dst.find('x')?.jumpSessionId).toBeUndefined();
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
