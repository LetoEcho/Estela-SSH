import { linux } from './linux';
import type { Platform } from './types';
import { win32 } from './win32';

// The only process.platform check in the codebase.
function select(): Platform {
  if (process.platform === 'linux') return linux;
  if (process.platform === 'win32') return win32;
  throw new Error(`Platform not supported yet: ${process.platform}`);
}

export const platform = select();
export type { Platform };
