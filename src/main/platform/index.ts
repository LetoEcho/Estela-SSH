import { linux } from './linux';
import type { Platform } from './types';

// The only process.platform check in the codebase. win32 arrives after the Linux version is done.
function select(): Platform {
  if (process.platform === 'linux') return linux;
  throw new Error(`Platform not supported yet: ${process.platform}`);
}

export const platform = select();
export type { Platform };
