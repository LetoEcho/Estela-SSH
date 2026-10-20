import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Settings } from '../shared/ipc';
import { call, type Sftp } from './ssh/sftp';

const MAX_EDIT_BYTES = 5 * 1024 * 1024;
const SAVE_DEBOUNCE_MS = 400;

interface Edit {
  connId: string;
  remote: string;
  name: string;
}

export interface EditorDeps {
  sftp(connId: string): Promise<Sftp>;
  settings(): Settings;
  openWindow(editId: string): void;
  openExternal(command: string, file: string): void;
  notice(message: string): void;
  /** Directory for local copies used by external editors. */
  tempDir: string;
}

/** Remote file editing: an internal Monaco window, or a local copy watched and uploaded on every save. */
export class EditorManager {
  private edits = new Map<string, Edit>();
  private watchers = new Map<string, { connId: string; close(): void }>();

  constructor(private readonly deps: EditorDeps) {}

  async open(connId: string, remote: string): Promise<void> {
    const name = path.posix.basename(remote);
    const sftp = await this.deps.sftp(connId);
    const st = await call<{ size: number; isFile(): boolean }>((cb) => sftp.stat(remote, cb));
    if (!st.isFile()) throw new Error(`${name} no es un fichero`);
    if (st.size > MAX_EDIT_BYTES) throw new Error(`${name} es demasiado grande para editarlo (máx. 5 MB)`);

    const s = this.deps.settings();
    if (s.editor === 'internal') {
      const id = randomUUID();
      this.edits.set(id, { connId, remote, name });
      this.deps.openWindow(id);
      return;
    }
    // External: download a private copy, open it, upload whenever it changes on disk.
    const dir = fs.mkdtempSync(path.join(this.deps.tempDir, 'edit-'));
    const local = path.join(dir, name);
    await call((cb) => sftp.fastGet(remote, local, cb));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last: Buffer = fs.readFileSync(local);
    const watcher = fs.watch(dir, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void (async () => {
          let now: Buffer;
          try {
            now = fs.readFileSync(local);
          } catch {
            return; // editors that save via rename briefly remove the file
          }
          if (now.equals(last)) return;
          last = now;
          try {
            const sftp = await this.deps.sftp(connId);
            await call((cb) => sftp.fastPut(local, remote, cb));
            this.deps.notice(`Subido ${name}`);
          } catch (e) {
            this.deps.notice(`No se pudo subir ${name}: ${e instanceof Error ? e.message : e}`);
          }
        })();
      }, SAVE_DEBOUNCE_MS);
    });
    this.watchers.set(local, {
      connId,
      close: () => {
        watcher.close();
        fs.rmSync(dir, { recursive: true, force: true });
      },
    });
    this.deps.openExternal(s.externalEditor, local);
  }

  async load(editId: string): Promise<{ name: string; path: string; content: string }> {
    const e = this.edit(editId);
    const sftp = await this.deps.sftp(e.connId);
    const data = await call<Buffer>((cb) => sftp.readFile(e.remote, cb));
    if (data.subarray(0, 8192).includes(0)) throw new Error(`${e.name} parece un fichero binario`);
    return { name: e.name, path: e.remote, content: data.toString('utf8') };
  }

  async save(editId: string, content: string): Promise<void> {
    const e = this.edit(editId);
    const sftp = await this.deps.sftp(e.connId);
    await call((cb) => sftp.writeFile(e.remote, content, cb));
  }

  /** Stop syncing files of a connection that went away. */
  connectionClosed(connId: string): void {
    for (const [k, w] of this.watchers) if (w.connId === connId) (w.close(), this.watchers.delete(k));
  }

  dispose(): void {
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }

  private edit(id: string): Edit {
    const e = this.edits.get(id);
    if (!e) throw new Error('Edición no encontrada');
    return e;
  }
}
