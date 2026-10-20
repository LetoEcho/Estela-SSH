import fs from 'node:fs';
import path from 'node:path';
import type { SFTPWrapper, Stats } from 'ssh2';
import type { SftpEntry, TransferState } from '../../shared/ipc';

// Remote paths are always posix.
const rpath = path.posix;

/** Turns a node-style callback API into a promise. */
export const call = <T = void>(fn: (cb: (err: Error | null | undefined, result?: T) => void) => void) =>
  new Promise<T>((resolve, reject) => fn((err, result) => (err ? reject(err) : resolve(result as T))));

/** The subset of SFTPWrapper we use; tests pass a fake. */
export type Sftp = Pick<
  SFTPWrapper,
  'readdir' | 'stat' | 'lstat' | 'mkdir' | 'rmdir' | 'unlink' | 'rename' | 'chmod' | 'realpath' | 'fastGet' | 'fastPut' | 'end' | 'readFile' | 'writeFile'
>;

export async function list(sftp: Sftp, dir: string): Promise<SftpEntry[]> {
  const items = await call<{ filename: string; attrs: Stats }[]>((cb) => sftp.readdir(dir, cb));
  const entries = await Promise.all(
    items
      .filter((i) => i.filename !== '.' && i.filename !== '..')
      .map(async ({ filename, attrs }): Promise<SftpEntry> => {
        const p = rpath.join(dir, filename);
        const type = attrs.isDirectory() ? 'dir' : attrs.isSymbolicLink() ? 'link' : 'file';
        let isDir = type === 'dir';
        if (type === 'link') {
          isDir = await call<Stats>((cb) => sftp.stat(p, cb)).then((s) => s.isDirectory(), () => false);
        }
        return { name: filename, path: p, type, isDir, size: attrs.size, mtime: attrs.mtime, mode: attrs.mode & 0o7777 };
      }),
  );
  return entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
}

/** rm -r without following symlinks (a link to a dir is unlinked, its target is untouched). */
export async function remove(sftp: Sftp, p: string): Promise<void> {
  const st = await call<Stats>((cb) => sftp.lstat(p, cb));
  if (!st.isDirectory()) return call((cb) => sftp.unlink(p, cb));
  for (const child of await call<{ filename: string }[]>((cb) => sftp.readdir(p, cb))) {
    if (child.filename !== '.' && child.filename !== '..') await remove(sftp, rpath.join(p, child.filename));
  }
  await call((cb) => sftp.rmdir(p, cb));
}

/** mkdir -p */
export async function mkdirp(sftp: Sftp, dir: string): Promise<void> {
  const exists = await call<Stats>((cb) => sftp.stat(dir, cb)).then((s) => s.isDirectory(), () => false);
  if (exists) return;
  const parent = rpath.dirname(dir);
  if (parent !== dir) await mkdirp(sftp, parent);
  await call((cb) => sftp.mkdir(dir, cb));
}

export async function exists(sftp: Sftp, p: string): Promise<boolean> {
  return call<Stats>((cb) => sftp.lstat(p, cb)).then(() => true, () => false);
}

/** Every file below `dir` (recursive), with sizes, plus the directories to recreate. */
export async function walk(sftp: Sftp, dir: string): Promise<{ files: { path: string; size: number }[]; dirs: string[] }> {
  const files: { path: string; size: number }[] = [];
  const dirs: string[] = [dir];
  for (const e of await list(sftp, dir)) {
    if (e.type === 'dir') {
      const sub = await walk(sftp, e.path);
      files.push(...sub.files);
      dirs.push(...sub.dirs);
    } else if (e.type === 'file') {
      files.push({ path: e.path, size: e.size });
    }
    // ponytail: symlinks inside downloaded trees are skipped; follow them if someone needs it.
  }
  return { files, dirs };
}

/**
 * Copies one file in the transfer's direction. Aborting rejects at once and removes the
 * partial target (`cleanupSftp` is a still-open channel for deleting a partial upload).
 */
export async function transferFile(
  sftp: Sftp,
  t: Pick<TransferState, 'direction' | 'source' | 'target'>,
  progress: (done: number) => void,
  signal: AbortSignal,
  cleanupSftp: () => Promise<Sftp>,
): Promise<void> {
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new Error('cancelled'));
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  });
  const step = (done: number) => progress(done);
  try {
    await Promise.race([
      aborted,
      call((cb) => (t.direction === 'up' ? sftp.fastPut(t.source, t.target, { step }, cb) : sftp.fastGet(t.source, t.target, { step }, cb))),
    ]);
  } catch (e) {
    if (signal.aborted) {
      sftp.end(); // stops the in-flight requests before we delete what they were writing
      if (t.direction === 'down') fs.rmSync(t.target, { force: true });
      else await cleanupSftp().then((s) => call((cb) => s.unlink(t.target, cb))).catch(() => {});
    }
    throw e;
  }
}
