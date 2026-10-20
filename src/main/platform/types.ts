import type { LocalShell } from '../../shared/ipc';

export interface ShellSpawn {
  file: string;
  args: string[];
  env: Record<string, string>;
  /** Whether the shell will report its cwd with OSC 7. */
  osc7: boolean;
}

/** Everything OS-specific lives behind this interface; one implementation per OS. Grows phase by phase. */
export interface Platform {
  /** Value for ssh2's `agent` option, or undefined when no agent is reachable. */
  sshAgent(): string | undefined;
  /** Which keyring backs Electron's safeStorage; `secure: false` means secrets would be stored obfuscated only. */
  secretBackend(): { name: string; secure: boolean };
  /** Installed interactive shells, the user's default first. */
  localShells(): LocalShell[];
  /** How to start a local shell so that it emits OSC 7; rc files go under `hookDir`. */
  localShellSpawn(shellPath: string, hookDir: string): ShellSpawn;
  /** cwd of a local process, or null. */
  processCwd(pid: number): string | null;
  /** RDP client to launch, or an error with an install hint. */
  rdpClient(): { kind: 'freerdp' | 'mstsc'; path: string } | { error: string };
  /** mstsc only: writes (or with null deletes) the Credential Manager entry `target`. */
  rdpCredential(target: string, user: string, password: string | null): Promise<void>;
  /** Raises the window(s) of a process; false if not possible here. */
  focusWindow(pid: number): Promise<boolean>;
  /** Opens a local file in the user's external editor command line (e.g. "code --wait"). */
  openInEditor(command: string, file: string): void;
}
