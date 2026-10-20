import type { EstelaApi } from '../../shared/ipc';

/** The typed IPC bridge exposed by the preload. */
export const estela: EstelaApi = (window as unknown as { estela: EstelaApi }).estela;

/** Electron wraps errors from ipcMain.handle as "Error invoking remote method 'x': Error: msg". */
export const cleanError = (e: unknown) =>
  String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
