import type { SecretStatus } from '../../shared/ipc';
import type { SecretKind } from '../../shared/session';
import { readJson, writeAtomic } from './fs-util';

/** The subset of Electron's safeStorage we use; injected so tests can mock it. */
export interface Cipher {
  encryptString(plain: string): Buffer;
  decryptString(enc: Buffer): string;
}

interface SecretsFile {
  acceptedInsecure: boolean;
  entries: Record<string, string>; // key "<sessionId>:<kind>" → base64 ciphertext
}

export class SecretStore {
  private data: SecretsFile;

  constructor(
    private readonly file: string,
    private readonly cipher: Cipher,
    private readonly backend: { name: string; secure: boolean },
  ) {
    this.data = (readJson(file) as SecretsFile | undefined) ?? { acceptedInsecure: false, entries: {} };
  }

  status(): SecretStatus {
    return { backend: this.backend.name, secure: this.backend.secure, acceptedInsecure: this.data.acceptedInsecure };
  }

  canStore(): boolean {
    return this.backend.secure || this.data.acceptedInsecure;
  }

  acceptInsecure(): void {
    this.data.acceptedInsecure = true;
    this.persist();
  }

  has(sessionId: string, kind: SecretKind): boolean {
    return key(sessionId, kind) in this.data.entries;
  }

  get(sessionId: string, kind: SecretKind): string | undefined {
    const enc = this.data.entries[key(sessionId, kind)];
    if (enc === undefined) return undefined;
    try {
      return this.cipher.decryptString(Buffer.from(enc, 'base64'));
    } catch {
      return undefined; // keyring changed or entry corrupt: behave as "not stored"
    }
  }

  /** null deletes. Throws when no keyring is available and the user has not accepted plain storage. */
  set(sessionId: string, kind: SecretKind, value: string | null): void {
    if (value === null) {
      delete this.data.entries[key(sessionId, kind)];
    } else {
      if (!this.canStore()) throw new Error('No system keyring available; storing secrets was not accepted');
      this.data.entries[key(sessionId, kind)] = this.cipher.encryptString(value).toString('base64');
    }
    this.persist();
  }

  deleteSession(sessionId: string): void {
    for (const k of Object.keys(this.data.entries)) if (k.startsWith(`${sessionId}:`)) delete this.data.entries[k];
    this.persist();
  }

  private persist(): void {
    writeAtomic(this.file, JSON.stringify(this.data, null, 2));
  }
}

const key = (sessionId: string, kind: SecretKind) => `${sessionId}:${kind}`;
