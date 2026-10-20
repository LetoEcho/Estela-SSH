import { safeStorage } from 'electron';
import type { Platform } from './types';

export const linux: Platform = {
  sshAgent: () => process.env['SSH_AUTH_SOCK'] || undefined,

  secretBackend() {
    const name = safeStorage.getSelectedStorageBackend();
    return { name, secure: safeStorage.isEncryptionAvailable() && name !== 'basic_text' && name !== 'unknown' };
  },
};
