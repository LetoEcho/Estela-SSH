import fs from 'node:fs';

export function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

/** Write via temp file + rename so a crash never leaves a half-written file. */
export function writeAtomic(file: string, data: string, mode = 0o600): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}
