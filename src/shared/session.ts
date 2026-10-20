export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  icon?: string;
}

export type SshAuth = 'password' | 'key' | 'agent';

export interface SshSession {
  type: 'ssh';
  id: string;
  name: string;
  folderId: string | null;
  color: string;
  /** An emoji, or a custom image embedded as a data: URL so exports stay self-contained. */
  icon: string;
  host: string;
  port: number;
  username: string;
  auth: SshAuth;
  /** Stored with a leading "~/" when under the home dir so the file stays portable. */
  keyPath?: string;
  jumpSessionId?: string;
  initialDir?: string;
}

// RDP sessions join this union in phase 3.
export type Session = SshSession;

export interface SessionsFile {
  version: 1;
  folders: Folder[];
  sessions: Session[];
}

export type SecretKind = 'password' | 'passphrase';

export const emptySessionsFile = (): SessionsFile => ({ version: 1, folders: [], sessions: [] });

// Validation runs on every trust boundary (IPC from the renderer, imported files).

function fail(msg: string): never {
  throw new Error(`Invalid data: ${msg}`);
}

function str(o: Record<string, unknown>, k: string, optional = false): string | undefined {
  const v = o[k];
  if (v === undefined || v === null || v === '') {
    if (optional) return undefined;
    fail(`${k} is required`);
  }
  if (typeof v !== 'string' || v.length > 4096) fail(`${k} must be a string`);
  return v;
}

function obj(x: unknown, what: string): Record<string, unknown> {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) fail(`${what} must be an object`);
  return x as Record<string, unknown>;
}

export const MAX_ICON_BYTES = 512 * 1024;
const ICON_DATA_URL = /^data:image\/(x-icon|vnd\.microsoft\.icon|png|svg\+xml);base64,[A-Za-z0-9+/]+=*$/;

function icon(o: Record<string, unknown>): string | undefined {
  const v = o['icon'];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') fail('icon must be a string');
  if (v.startsWith('data:')) {
    if (v.length > (MAX_ICON_BYTES * 4) / 3 + 64 || !ICON_DATA_URL.test(v)) fail('icon must be an .ico, .png or .svg image up to 512 KB');
  } else if (v.length > 16) {
    fail('icon must be an emoji or an image');
  }
  return v;
}

export function validateFolder(x: unknown): Folder {
  const o = obj(x, 'folder');
  const f: Folder = { id: str(o, 'id')!, name: str(o, 'name')!, parentId: str(o, 'parentId', true) ?? null };
  const i = icon(o);
  if (i) f.icon = i;
  return f;
}

export function validateSession(x: unknown): Session {
  const o = obj(x, 'session');
  if (o['type'] !== 'ssh') fail(`unsupported session type ${String(o['type'])}`);
  const port = o['port'];
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) fail('port must be 1-65535');
  const auth = o['auth'];
  if (auth !== 'password' && auth !== 'key' && auth !== 'agent') fail('auth must be password, key or agent');
  const s: SshSession = {
    type: 'ssh',
    id: str(o, 'id')!,
    name: str(o, 'name')!,
    folderId: str(o, 'folderId', true) ?? null,
    color: str(o, 'color', true) ?? '#4a90d9',
    icon: icon(o) ?? '🖥️',
    host: str(o, 'host')!,
    port: port as number,
    username: str(o, 'username')!,
    auth,
    keyPath: str(o, 'keyPath', true),
    jumpSessionId: str(o, 'jumpSessionId', true),
    initialDir: str(o, 'initialDir', true),
  };
  if (s.auth === 'key' && !s.keyPath) fail('keyPath is required for key auth');
  if (s.jumpSessionId === s.id) fail('a session cannot be its own jump host');
  return s;
}

export function validateSessionsFile(x: unknown): SessionsFile {
  const o = obj(x, 'sessions file');
  if (o['version'] !== 1) fail('unsupported version');
  if (!Array.isArray(o['folders']) || !Array.isArray(o['sessions'])) fail('folders and sessions must be arrays');
  return {
    version: 1,
    folders: o['folders'].map(validateFolder),
    sessions: o['sessions'].map(validateSession),
  };
}
