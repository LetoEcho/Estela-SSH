export type KeyAction =
  | 'copy'
  | 'paste'
  | 'nextTab'
  | 'prevTab'
  | 'closePane'
  | 'splitRight'
  | 'splitDown'
  | 'focusLeft'
  | 'focusRight'
  | 'focusUp'
  | 'focusDown'
  | 'search';

// One table per OS. Windows uses the same keys as Windows Terminal, which match the Linux table (the fallback).
const KEYMAPS: Record<string, Record<string, KeyAction>> = {
  linux: {
    'ctrl+shift+c': 'copy',
    'ctrl+shift+v': 'paste',
    'shift+insert': 'paste',
    'ctrl+pagedown': 'nextTab',
    'ctrl+pageup': 'prevTab',
    'ctrl+shift+w': 'closePane',
    // Same as Terminator.
    'ctrl+shift+e': 'splitRight',
    'ctrl+shift+o': 'splitDown',
    'alt+arrowleft': 'focusLeft',
    'alt+arrowright': 'focusRight',
    'alt+arrowup': 'focusUp',
    'alt+arrowdown': 'focusDown',
    'ctrl+shift+f': 'search',
  },
};

export function keyId(e: Pick<KeyboardEvent, 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'key'>): string {
  const mods = [e.ctrlKey && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift', e.metaKey && 'meta'].filter(Boolean);
  return [...mods, e.key.toLowerCase()].join('+');
}

export function keyAction(os: string, e: KeyboardEvent): KeyAction | undefined {
  return (KEYMAPS[os] ?? KEYMAPS['linux'])[keyId(e)];
}
