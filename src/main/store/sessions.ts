import {
  emptySessionsFile, validateFolder, validateSession, validateSessionsFile,
  type Session, type SessionsFile,
} from '../../shared/session';
import { readJson, writeAtomic } from './fs-util';

export class SessionStore {
  private data: SessionsFile;

  constructor(private readonly file: string) {
    const raw = readJson(file);
    this.data = raw === undefined ? emptySessionsFile() : validateSessionsFile(raw);
  }

  get(): SessionsFile {
    return structuredClone(this.data);
  }

  find(id: string): Session | undefined {
    return this.data.sessions.find((s) => s.id === id);
  }

  saveSession(input: unknown): void {
    const s = validateSession(input);
    this.checkFolder(s.folderId);
    if (s.jumpSessionId && this.jumpChainHas(s.jumpSessionId, s.id)) {
      throw new Error('Jump host chain would form a loop');
    }
    upsert(this.data.sessions, s);
    this.persist();
  }

  deleteSession(id: string): void {
    this.data.sessions = this.data.sessions.filter((s) => s.id !== id);
    for (const s of this.data.sessions) if (s.jumpSessionId === id) delete s.jumpSessionId;
    this.persist();
  }

  saveFolder(input: unknown): void {
    const f = validateFolder(input);
    this.checkFolder(f.parentId);
    for (let p = f.parentId; p; p = this.data.folders.find((x) => x.id === p)?.parentId ?? null) {
      if (p === f.id) throw new Error('A folder cannot be moved inside itself');
    }
    upsert(this.data.folders, f);
    this.persist();
  }

  /** Children (sessions and sub-folders) move up to the deleted folder's parent: nothing is lost. */
  deleteFolder(id: string): void {
    const folder = this.data.folders.find((f) => f.id === id);
    if (!folder) return;
    for (const s of this.data.sessions) if (s.folderId === id) s.folderId = folder.parentId;
    for (const f of this.data.folders) if (f.parentId === id) f.parentId = folder.parentId;
    this.data.folders = this.data.folders.filter((f) => f.id !== id);
    this.persist();
  }

  /** Merge an exported file: entries with the same id are replaced, the rest are added. */
  import(raw: unknown): number {
    const incoming = validateSessionsFile(raw);
    for (const f of incoming.folders) upsert(this.data.folders, f);
    for (const s of incoming.sessions) upsert(this.data.sessions, s);
    // Drop dangling references the importing machine cannot resolve.
    const folderIds = new Set(this.data.folders.map((f) => f.id));
    const sessionIds = new Set(this.data.sessions.map((s) => s.id));
    for (const f of this.data.folders) if (f.parentId && !folderIds.has(f.parentId)) f.parentId = null;
    for (const s of this.data.sessions) {
      if (s.folderId && !folderIds.has(s.folderId)) s.folderId = null;
      if (s.jumpSessionId && !sessionIds.has(s.jumpSessionId)) delete s.jumpSessionId;
    }
    this.persist();
    return incoming.sessions.length;
  }

  /** The export never contains secrets: they live in a separate store. */
  export(): string {
    return JSON.stringify(this.data, null, 2);
  }

  private jumpChainHas(start: string, target: string): boolean {
    const seen = new Set<string>();
    for (let id: string | undefined = start; id && !seen.has(id); id = this.find(id)?.jumpSessionId) {
      if (id === target) return true;
      seen.add(id);
    }
    return false;
  }

  private checkFolder(id: string | null): void {
    if (id && !this.data.folders.some((f) => f.id === id)) throw new Error(`Unknown folder ${id}`);
  }

  private persist(): void {
    writeAtomic(this.file, JSON.stringify(this.data, null, 2));
  }
}

function upsert<T extends { id: string }>(list: T[], item: T): void {
  const i = list.findIndex((x) => x.id === item.id);
  if (i >= 0) list[i] = item;
  else list.push(item);
}
