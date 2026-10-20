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
  'conn:open': (sessionId: string, cols: number, rows: number) => string;
}

/** ipcRenderer.send → ipcMain.on (hot path, no reply) */
export interface SendApi {
  'conn:write': [connId: string, data: string];
  'conn:resize': [connId: string, cols: number, rows: number];
  'conn:close': [connId: string];
  'prompt:answer': [promptId: string, answer: unknown];
}

/** webContents.send → ipcRenderer.on */
export interface EventApi {
  'conn:data': { connId: string; data: string };
  'conn:status': { connId: string; status: ConnStatus; error?: string };
  'sessions:changed': SessionsFile;
  'prompt:hostkey': HostKeyPrompt & { promptId: string };
  'prompt:auth': AuthPrompt & { promptId: string };
}

// Runtime allow-lists used by the preload; `satisfies` keeps them in sync with the types.
export const INVOKE_CHANNELS = [
  'sessions:get', 'sessions:saveSession', 'sessions:deleteSession', 'sessions:saveFolder',
  'sessions:deleteFolder', 'sessions:export', 'sessions:import', 'secrets:status',
  'secrets:acceptInsecure', 'secrets:has', 'secrets:set', 'dialog:openFile', 'dialog:pickIcon', 'conn:open',
] as const satisfies readonly (keyof InvokeApi)[];
export const SEND_CHANNELS = ['conn:write', 'conn:resize', 'conn:close', 'prompt:answer'] as const satisfies readonly (keyof SendApi)[];
export const EVENT_CHANNELS = ['conn:data', 'conn:status', 'sessions:changed', 'prompt:hostkey', 'prompt:auth'] as const satisfies readonly (keyof EventApi)[];

/** What the preload exposes as window.estela. */
export interface EstelaApi {
  os: string;
  invoke<K extends keyof InvokeApi>(channel: K, ...args: Parameters<InvokeApi[K]>): Promise<ReturnType<InvokeApi[K]>>;
  send<K extends keyof SendApi>(channel: K, ...args: SendApi[K]): void;
  on<K extends keyof EventApi>(channel: K, cb: (payload: EventApi[K]) => void): () => void;
}
