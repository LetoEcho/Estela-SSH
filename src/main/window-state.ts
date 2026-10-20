import { screen, type BrowserWindow, type Rectangle } from 'electron';
import { readJson, writeAtomic } from './store/fs-util';

interface WindowState {
  bounds: Rectangle;
  maximized: boolean;
}

/** Last size/position of the main window, ignored if it no longer fits any display. */
export function loadWindowState(file: string): WindowState | null {
  const s = readJson(file) as WindowState | undefined;
  if (!s?.bounds || s.bounds.width < 400 || s.bounds.height < 300) return null;
  const visible = screen.getAllDisplays().some(({ workArea: a }) => {
    const b = s.bounds;
    return b.x < a.x + a.width - 100 && b.x + b.width > a.x + 100 && b.y >= a.y - 10 && b.y < a.y + a.height - 100;
  });
  return visible ? s : null;
}

export function trackWindowState(win: BrowserWindow, file: string): void {
  win.on('close', () => {
    writeAtomic(file, JSON.stringify({ bounds: win.getNormalBounds(), maximized: win.isMaximized() }));
  });
}
