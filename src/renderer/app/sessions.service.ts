import { Injectable, computed, signal } from '@angular/core';
import type { SecretStatus } from '../../shared/ipc';
import { emptySessionsFile, type Folder, type Session, type SessionsFile } from '../../shared/session';
import { estela } from './estela';

export interface FolderNode {
  folder: Folder;
  folders: FolderNode[];
  sessions: Session[];
}

@Injectable({ providedIn: 'root' })
export class SessionsService {
  readonly data = signal<SessionsFile>(emptySessionsFile());
  readonly secretStatus = signal<SecretStatus | null>(null);

  /** Root-level pseudo node: folder is unused, children are the top-level items. */
  readonly tree = computed<FolderNode>(() => {
    const { folders, sessions } = this.data();
    const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);
    const build = (parentId: string | null): Omit<FolderNode, 'folder'> => ({
      folders: folders
        .filter((f) => f.parentId === parentId)
        .sort(byName)
        .map((folder) => ({ folder, ...build(folder.id) })),
      sessions: sessions.filter((s) => s.folderId === parentId).sort(byName),
    });
    return { folder: { id: '', name: '', parentId: null }, ...build(null) };
  });

  constructor() {
    estela.on('sessions:changed', (d) => this.data.set(d));
    void estela.invoke('sessions:get').then((d) => this.data.set(d));
    void this.refreshSecretStatus();
  }

  find(id: string): Session | undefined {
    return this.data().sessions.find((s) => s.id === id);
  }

  search(q: string): Session[] {
    const needle = q.trim().toLowerCase();
    return this.data().sessions.filter((s) =>
      [s.name, s.host, s.username].some((v) => v.toLowerCase().includes(needle)),
    );
  }

  saveSession = (s: Session) => estela.invoke('sessions:saveSession', s);
  deleteSession = (id: string) => estela.invoke('sessions:deleteSession', id);
  saveFolder = (f: Folder) => estela.invoke('sessions:saveFolder', f);
  deleteFolder = (id: string) => estela.invoke('sessions:deleteFolder', id);
  export = () => estela.invoke('sessions:export');
  import = () => estela.invoke('sessions:import');

  duplicate(s: Session): Promise<void> {
    return this.saveSession({ ...structuredClone(s), id: crypto.randomUUID(), name: `${s.name} (copia)` });
  }

  async refreshSecretStatus(): Promise<void> {
    this.secretStatus.set(await estela.invoke('secrets:status'));
  }

  async acceptInsecureSecrets(): Promise<void> {
    await estela.invoke('secrets:acceptInsecure');
    await this.refreshSecretStatus();
  }

  canStoreSecrets(): boolean {
    const st = this.secretStatus();
    return !!st && (st.secure || st.acceptedInsecure);
  }
}
