/** Everything OS-specific lives behind this interface; one implementation per OS. Grows phase by phase. */
export interface Platform {
  /** Value for ssh2's `agent` option, or undefined when no agent is reachable. */
  sshAgent(): string | undefined;
  /** Which keyring backs Electron's safeStorage; `secure: false` means secrets would be stored obfuscated only. */
  secretBackend(): { name: string; secure: boolean };
}
