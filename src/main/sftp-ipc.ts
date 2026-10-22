import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, nativeImage, type BrowserWindow } from 'electron';
import type { EventApi, InvokeApi, SendApi, TransferDirection } from '../shared/ipc';
import type { LocalPty } from './local/pty';
import type { SerialPane } from './serial/serial';
import { localName } from './paths';
import { SshShell } from './ssh/connection';
import { call, exists, list, mkdirp, remove, transferFile, walk } from './ssh/sftp';
import { TransferQueue, type TransferRunner } from './ssh/transfers';

const rpath = path.posix;
const DRAG_OUT_MAX_BYTES = 50 * 1024 * 1024;

type Handle = (ch: keyof InvokeApi, fn: (...args: unknown[]) => unknown) => void;
type On = (ch: keyof SendApi, fn: (...args: unknown[]) => void) => void;
type Emit = <K extends keyof EventApi>(ch: K, payload: EventApi[K]) => void;

export interface SftpIpcDeps {
  win: BrowserWindow;
  shells: Map<string, SshShell | LocalPty | SerialPane>;
  handle: Handle;
  on: On;
  emit: Emit;
  str: (x: unknown) => string;
}

/** Remote paths from the renderer: absolute, normalised, with a usable basename. */
function remotePath(x: string): string {
  const p = rpath.normalize(x);
  if (!rpath.isAbsolute(p)) throw new Error(`Remote path must be absolute: ${x}`);
  return p;
}
function remoteItem(x: string): string {
  const p = remotePath(x);
  if (p === '/') throw new Error('Cannot operate on /');
  return p;
}

export function registerSftpIpc({ win, shells, handle, on, emit, str }: SftpIpcDeps): { dispose(): void; connectionClosed(connId: string): void } {
  const conn = (id: unknown) => {
    const s = shells.get(str(id));
    if (!s) throw new Error('La conexión ya no está abierta');
    return s;
  };
  const shell = (id: unknown) => {
    const s = conn(id);
    if (!(s instanceof SshShell)) throw new Error('SFTP solo está disponible en sesiones SSH');
    return s;
  };
  const sftpOf = (id: unknown) => shell(id).sftp();
  const strList = (x: unknown) => {
    if (!Array.isArray(x) || x.length > 10_000) throw new Error('Expected a list of paths');
    return x.map(str);
  };
  const tempDirs: string[] = [];

  const runner: TransferRunner = async (t, progress, signal) => {
    const sftp = await shell(t.connId).openSftp();
    try {
      await transferFile(sftp, t, progress, signal, () => shell(t.connId).sftp());
    } finally {
      sftp.end();
    }
  };
  const queue = new TransferQueue(runner, (s) => emit('transfer:update', s));

  handle('conn:cwd', (id) => conn(id).cwd());
  on('conn:retryHook', (id) => shells.get(str(id))?.retryHook());

  handle('sftp:home', async (id) => {
    const sftp = await sftpOf(id);
    return call<string>((cb) => sftp.realpath('.', cb));
  });
  handle('sftp:list', async (id, dir) => list(await sftpOf(id), remotePath(str(dir))));
  handle('sftp:mkdir', async (id, p) => {
    const sftp = await sftpOf(id);
    await call((cb) => sftp.mkdir(remoteItem(str(p)), cb));
  });
  handle('sftp:rename', async (id, from, to) => {
    const sftp = await sftpOf(id);
    await call((cb) => sftp.rename(remoteItem(str(from)), remoteItem(str(to)), cb));
  });
  handle('sftp:delete', async (id, paths) => {
    const sftp = await sftpOf(id);
    for (const p of strList(paths)) await remove(sftp, remoteItem(p));
  });
  handle('sftp:chmod', async (id, p, mode) => {
    if (!Number.isInteger(mode) || (mode as number) < 0 || (mode as number) > 0o7777) throw new Error('Invalid mode');
    const sftp = await sftpOf(id);
    await call((cb) => sftp.chmod(remoteItem(str(p)), mode as number, cb));
  });

  handle('transfer:conflicts', async (id, direction, sources, targetDir) => {
    const names = strList(sources).map((s) => (direction === 'up' ? path.basename(s) : rpath.basename(remoteItem(s))));
    if ((direction as TransferDirection) === 'up') {
      const sftp = await sftpOf(id);
      const dir = remotePath(str(targetDir));
      const found = await Promise.all(names.map((n) => exists(sftp, rpath.join(dir, n))));
      return names.filter((_, i) => found[i]);
    }
    const dir = targetDir ? str(targetDir) : app.getPath('downloads');
    return names.filter((n) => fs.existsSync(path.join(dir, localName(n))));
  });

  handle('transfer:upload', async (id, localPaths, remoteDir) => {
    const connId = str(id);
    const sftp = await sftpOf(connId);
    const dir = remotePath(str(remoteDir));
    for (const local of strList(localPaths)) {
      const st = fs.statSync(local);
      if (!st.isDirectory()) {
        queue.add({ connId, direction: 'up', name: path.basename(local), source: local, target: rpath.join(dir, path.basename(local)), size: st.size });
        continue;
      }
      // Recreate the tree remotely (including empty dirs), then queue every file.
      const base = path.dirname(local);
      const toRemote = (p: string) => rpath.join(dir, ...path.relative(base, p).split(path.sep));
      await mkdirp(sftp, toRemote(local));
      for (const e of fs.readdirSync(local, { recursive: true, withFileTypes: true })) {
        const full = path.join(e.parentPath, e.name);
        if (e.isDirectory()) await mkdirp(sftp, toRemote(full));
        else if (e.isFile()) {
          queue.add({ connId, direction: 'up', name: path.relative(base, full), source: full, target: toRemote(full), size: fs.statSync(full).size });
        }
      }
    }
  });

  handle('transfer:download', async (id, remotePaths, localDir) => {
    const connId = str(id);
    const sftp = await sftpOf(connId);
    const dir = localDir ? str(localDir) : app.getPath('downloads');
    for (const remote of strList(remotePaths).map(remoteItem)) {
      const entries = await list(sftp, rpath.dirname(remote));
      const entry = entries.find((e) => e.path === remote);
      if (!entry) throw new Error(`No existe: ${remote}`);
      if (!entry.isDir) {
        queue.add({ connId, direction: 'down', name: entry.name, source: remote, target: path.join(dir, localName(entry.name)), size: entry.size });
        continue;
      }
      const base = rpath.dirname(remote);
      const toLocal = (p: string) => path.join(dir, ...rpath.relative(base, p).split('/').map((n) => localName(n)));
      const tree = await walk(sftp, remote);
      for (const d of tree.dirs) fs.mkdirSync(toLocal(d), { recursive: true });
      for (const f of tree.files) {
        queue.add({ connId, direction: 'down', name: rpath.relative(base, f.path), source: f.path, target: toLocal(f.path), size: f.size });
      }
    }
  });

  handle('transfer:cancel', (tid) => queue.cancel(str(tid)));

  // Native drag to the file manager needs real local files, so small selections are fetched first.
  // ponytail: best effort — if the mouse is released before the download ends, the drag doesn't start.
  on('sftp:dragOut', (id, paths) => {
    void (async () => {
      const sftp = await sftpOf(id);
      const remotes = strList(paths).map(remoteItem);
      const entries = (await Promise.all(remotes.map((r) => list(sftp, rpath.dirname(r))))).flat();
      const picked = remotes.map((r) => entries.find((e) => e.path === r));
      if (picked.some((e) => !e || e.isDir)) throw new Error('Solo se pueden arrastrar ficheros; para carpetas usa «Descargar en…»');
      const total = picked.reduce((n, e) => n + e!.size, 0);
      if (total > DRAG_OUT_MAX_BYTES) throw new Error('Demasiado grande para arrastrar (máx. 50 MB); usa «Descargar en…»');
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'estela-drag-'));
      tempDirs.push(tmp);
      const files: string[] = [];
      for (const e of picked) {
        const local = path.join(tmp, localName(e!.name));
        await call((cb) => sftp.fastGet(e!.path, local, cb));
        files.push(local);
      }
      win.webContents.startDrag({ file: files[0], files, icon: dragIcon() });
    })().catch((e: Error) => emit('app:notice', { message: e.message }));
  });

  return {
    connectionClosed: (connId) => queue.cancelConnection(connId),
    dispose: () => {
      for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    },
  };
}

let icon: Electron.NativeImage | undefined;
function dragIcon(): Electron.NativeImage {
  // A plain 16×16 square; GTK needs a non-empty image.
  return (icon ??= nativeImage.createFromBuffer(Buffer.alloc(16 * 16 * 4, 0xa0), { width: 16, height: 16 }));
}
