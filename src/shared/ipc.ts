import type { Folder, SecretKind, Session, SessionsFile } from './session';

export type ConnStatus = 'connecting' | 'connected' | 'closed' | 'error';

export interface SecretStatus {
  backend: string;
  secure: boolean;
  acceptedInsecure: boolean;
}

export interface HostKeyPrompt {
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
  /** Set when a different key was stored for this host: possible MITM. */
  oldFingerprint?: string;
}
export type HostKeyAnswer = 'once' | 'save' | 'reject';

export interface AuthPrompt {
  title: string;
  label: string;
  /** True when the answer is a secret that may be stored (password / passphrase). */
  canSave: boolean;
}
export type AuthAnswer = { value: string; save: boolean } | null;

/** A generic multiple-choice question (e.g. FreeRDP's certificate prompt). Answer: a choice value or null. */
export interface ChoicePrompt {
  title: string;
  text: string;
  warning?: boolean;
  choices: { value: string; label: string; primary?: boolean }[];
}

export interface RdpStatus {
  rdpId: string;
  state: 'starting' | 'running' | 'exited' | 'error';
  error?: string;
}

export interface SftpEntry {
  name: string;
  /** Absolute remote path (posix). */
  path: string;
  type: 'dir' | 'file' | 'link';
  /** True for directories and for symlinks pointing at directories. */
  isDir: boolean;
  size: number;
  /** Seconds since epoch. */
  mtime: number;
  /** Permission bits (e.g. 0o755). */
  mode: number;
}

export type TransferDirection = 'up' | 'down';
export interface TransferState {
  id: string;
  connId: string;
  direction: TransferDirection;
  name: string;
  source: string;
  target: string;
  size: number;
  transferred: number;
  state: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  error?: string;
}

export interface LocalShell {
  path: string;
  name: string;
}

/** A serial port the OS reports; only what the session dialog shows. */
export interface SerialPortInfo {
  /** COM3, /dev/ttyUSB0… */
  path: string;
  /** Windows' friendly name ("USB Serial Port (COM3)") or the manufacturer, when known. */
  label?: string;
}

export interface TunnelStatus {
  sessionId: string;
  tunnelId: string;
  state: 'starting' | 'running' | 'stopped' | 'error';
  /** Actual listening port (useful when the configured one is 0). */
  port?: number;
  error?: string;
}

export interface Settings {
  /** 'internal' = Monaco window; otherwise the command line of an external editor, e.g. "code --wait". */
  editor: 'internal' | 'external';
  externalEditor: string;
  theme: 'system' | 'dark' | 'light';
  fontFamily: string;
  fontSize: number;
  scrollback: number;
  copyOnSelect: boolean;
  rightClickPaste: boolean;
  /** SSH keepalive interval in seconds; 0 disables it. */
  keepaliveSec: number;
  /** Reconnect SSH panes that drop because of a network error (not after a normal exit). */
  autoReconnect: boolean;
  /** Where session logs go; empty = default (Documents/Estela SSH logs). */
  logDir: string;
}

/** ipcRenderer.invoke → ipcMain.handle */
export interface InvokeApi {
  'sessions:get': () => SessionsFile;
  'sessions:saveSession': (s: Session) => void;
  'sessions:deleteSession': (id: string) => void;
  'sessions:saveFolder': (f: Folder) => void;
  'sessions:deleteFolder': (id: string) => void;
  'sessions:export': () => boolean;
  'sessions:import': () => number | null;
  'secrets:status': () => SecretStatus;
  'secrets:acceptInsecure': () => void;
  'secrets:has': (sessionId: string, kind: SecretKind) => boolean;
  'secrets:set': (sessionId: string, kind: SecretKind, value: string | null) => void;
  'dialog:openFile': (title: string) => string | null;
  /** Picks an .ico/.png/.svg and returns it as a data: URL. */
  'dialog:pickIcon': () => string | null;
  'dialog:openFiles': (title: string) => string[];
  'dialog:openDir': (title: string) => string | null;
  'conn:open': (sessionId: string, cols: number, rows: number) => string;
  /** Reads the shell's cwd from /proc (fallback when the shell does not emit OSC 7). */
  'conn:cwd': (connId: string) => string | null;
  'sftp:home': (connId: string) => string;
  'sftp:list': (connId: string, dir: string) => SftpEntry[];
  'sftp:mkdir': (connId: string, path: string) => void;
  'sftp:rename': (connId: string, from: string, to: string) => void;
  'sftp:delete': (connId: string, paths: string[]) => void;
  'sftp:chmod': (connId: string, path: string, mode: number) => void;
  /** Names among `sources` that already exist in `targetDir` (local dir for downloads, remote for uploads). */
  'transfer:conflicts': (connId: string, direction: TransferDirection, sources: string[], targetDir: string) => string[];
  'transfer:upload': (connId: string, localPaths: string[], remoteDir: string) => void;
  /** localDir null = the user's Downloads folder. */
  'transfer:download': (connId: string, remotePaths: string[], localDir: string | null) => void;
  'transfer:cancel': (id: string) => void;
  'local:shells': () => LocalShell[];
  'conn:openLocal': (shellPath: string, cols: number, rows: number) => string;
  /** Serial ports the OS reports, for the session dialog. */
  'serial:list': () => SerialPortInfo[];
  'tunnel:list': () => TunnelStatus[];
  'tunnel:start': (sessionId: string, tunnelId: string) => void;
  'tunnel:stop': (tunnelId: string) => void;
  /** Returns an id for the RDP tab; progress arrives as 'rdp:status'. */
  'rdp:launch': (sessionId: string) => string;
  'rdp:focus': (rdpId: string) => boolean;
  'rdp:stop': (rdpId: string) => void;
  /** Imports Host entries from ~/.ssh/config into a folder; returns how many sessions were added. */
  'import:sshConfig': () => number;
  /** Merges ~/.ssh/known_hosts into ours; returns how many lines were added. */
  'import:knownHosts': () => number;
  'settings:get': () => Settings;
  'app:info': () => { version: string; defaultLogDir: string };
  /** Returns the settings as stored (validated). */
  'settings:set': (s: Settings) => Settings;
  /** Opens a remote file in the configured editor (internal window or external command). */
  'editor:open': (connId: string, remotePath: string) => void;
  /** For the editor window: the file it was opened for. */
  'editor:load': (editId: string) => { name: string; path: string; content: string };
  'editor:save': (editId: string, content: string) => void;
}

/** ipcRenderer.send → ipcMain.on (hot path, no reply) */
export interface SendApi {
  'conn:write': [connId: string, data: string];
  'conn:resize': [connId: string, cols: number, rows: number];
  'conn:close': [connId: string];
  'prompt:answer': [promptId: string, answer: unknown];
  /** Re-type the cwd hook (user confirmed the command line is empty). */
  'conn:retryHook': [connId: string];
  /** Download small files to a temp dir and start a native drag with them. */
  'sftp:dragOut': [connId: string, remotePaths: string[]];
}

/** webContents.send → ipcRenderer.on */
export interface EventApi {
  'conn:data': { connId: string; data: string };
  'conn:status': { connId: string; status: ConnStatus; error?: string };
  'sessions:changed': SessionsFile;
  'prompt:hostkey': HostKeyPrompt & { promptId: string };
  'prompt:auth': AuthPrompt & { promptId: string };
  /** The cwd hook finished: `installed` = OSC 7 will arrive; `pid` enables the /proc fallback. */
  'conn:hook': { connId: string; installed: boolean; pid?: number };
  'transfer:update': TransferState;
  /** Non-fatal problems the user should see (e.g. a failed drag-out). */
  'app:notice': { message: string };
  'prompt:choice': ChoicePrompt & { promptId: string };
  'tunnel:status': TunnelStatus;
  'rdp:status': RdpStatus;
}

// Runtime allow-lists used by the preload; `satisfies` keeps them in sync with the types.
export const INVOKE_CHANNELS = [
  'sessions:get', 'sessions:saveSession', 'sessions:deleteSession', 'sessions:saveFolder',
  'sessions:deleteFolder', 'sessions:export', 'sessions:import', 'secrets:status',
  'secrets:acceptInsecure', 'secrets:has', 'secrets:set', 'dialog:openFile', 'dialog:pickIcon', 'dialog:openFiles',
  'dialog:openDir', 'conn:open', 'conn:cwd', 'sftp:home', 'sftp:list', 'sftp:mkdir', 'sftp:rename', 'sftp:delete',
  'sftp:chmod', 'transfer:conflicts', 'transfer:upload', 'transfer:download', 'transfer:cancel', 'local:shells',
  'conn:openLocal', 'serial:list', 'tunnel:list', 'tunnel:start', 'tunnel:stop', 'rdp:launch', 'rdp:focus', 'rdp:stop',
  'import:sshConfig', 'import:knownHosts', 'settings:get', 'settings:set', 'app:info', 'editor:open', 'editor:load', 'editor:save',
] as const satisfies readonly (keyof InvokeApi)[];
export const SEND_CHANNELS = ['conn:write', 'conn:resize', 'conn:close', 'prompt:answer', 'conn:retryHook', 'sftp:dragOut'] as const satisfies readonly (keyof SendApi)[];
export const EVENT_CHANNELS = [
  'conn:data', 'conn:status', 'sessions:changed', 'prompt:hostkey', 'prompt:auth', 'conn:hook', 'transfer:update', 'app:notice',
  'prompt:choice', 'tunnel:status', 'rdp:status',
] as const satisfies readonly (keyof EventApi)[];

/** What the preload exposes as window.estela. */
export interface EstelaApi {
  os: string;
  /** Local path of a File dropped from the OS file manager. */
  pathForFile(file: File): string;
  invoke<K extends keyof InvokeApi>(channel: K, ...args: Parameters<InvokeApi[K]>): Promise<ReturnType<InvokeApi[K]>>;
  send<K extends keyof SendApi>(channel: K, ...args: SendApi[K]): void;
  on<K extends keyof EventApi>(channel: K, cb: (payload: EventApi[K]) => void): () => void;
}
