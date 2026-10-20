import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';

export type HostKeyCheck =
  | { result: 'match' }
  | { result: 'unknown' }
  | { result: 'changed'; oldFingerprint: string };

/** OpenSSH host notation: plain host for port 22, "[host]:port" otherwise. */
export const hostId = (host: string, port: number) => (port === 22 ? host : `[${host}]:${port}`);

export const fingerprint = (keyBlob: Buffer) =>
  `SHA256:${createHash('sha256').update(keyBlob).digest('base64').replace(/=+$/, '')}`;

/** The key type is the first SSH string inside the wire-format public key blob. */
export function keyType(keyBlob: Buffer): string {
  const len = keyBlob.readUInt32BE(0);
  return keyBlob.subarray(4, 4 + len).toString('ascii');
}

interface Entry { hosts: string[]; type: string; key: string }

/** Host field match, including OpenSSH hashed hosts: |1|base64(salt)|base64(HMAC-SHA1(salt, host)). */
function matches(e: Entry, id: string): boolean {
  return e.hosts.some((h) => {
    if (!h.startsWith('|1|')) return h === id;
    const [, , salt, hash] = h.split('|');
    return createHmac('sha1', Buffer.from(salt, 'base64')).update(id).digest('base64') === hash;
  });
}

/** Our own known_hosts file, in OpenSSH format so ~/.ssh/known_hosts can be imported as-is. */
export class KnownHosts {
  constructor(private readonly file: string) {}

  check(host: string, port: number, keyBlob: Buffer): HostKeyCheck {
    const id = hostId(host, port);
    const b64 = keyBlob.toString('base64');
    const mine = this.entries().filter((e) => matches(e, id));
    if (mine.length === 0) return { result: 'unknown' };
    if (mine.some((e) => e.key === b64)) return { result: 'match' };
    // Any stored key for this host that does not match is treated as a change (safe side).
    return { result: 'changed', oldFingerprint: fingerprint(Buffer.from(mine[0].key, 'base64')) };
  }

  /** Stores the key, replacing any previous key for the same host. */
  add(host: string, port: number, keyBlob: Buffer): void {
    const id = hostId(host, port);
    const kept = this.lines().filter((l) => {
      const e = parse(l);
      return !e || !matches(e, id);
    });
    kept.push(`${id} ${keyType(keyBlob)} ${keyBlob.toString('base64')}`);
    fs.writeFileSync(this.file, kept.join('\n') + '\n', { mode: 0o600 });
  }

  private lines(): string[] {
    try {
      return fs.readFileSync(this.file, 'utf8').split('\n').filter((l) => l.trim());
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }

  private entries(): Entry[] {
    return this.lines().map(parse).filter((e): e is Entry => e !== null);
  }

  /**
   * Appends entries from an OpenSSH known_hosts file that we don't have yet. Returns how many.
   * ponytail: @cert-authority / @revoked lines are skipped (no CA-signed host keys support).
   */
  importFrom(text: string): number {
    const mine = new Set(this.lines().map((l) => l.trim()));
    const fresh = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => parse(l) && !mine.has(l));
    const unique = [...new Set(fresh)];
    if (unique.length) fs.appendFileSync(this.file, unique.join('\n') + '\n', { mode: 0o600 });
    return unique.length;
  }
}

function parse(line: string): Entry | null {
  const t = line.trim();
  if (!t || t.startsWith('#') || t.startsWith('@')) return null;
  const [hosts, type, key] = t.split(/\s+/);
  return key ? { hosts: hosts.split(','), type, key } : null;
}
