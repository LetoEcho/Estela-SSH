export type KeyAction = 'copy' | 'paste' | 'nextTab' | 'prevTab' | 'closeTab';

// One table per OS; the windows table arrives with the Windows platform work.
const KEYMAPS: Record<string, Record<string, KeyAction>> = {
  linux: {
    'ctrl+shift+c': 'copy',
    'ctrl+shift+v': 'paste',
    'shift+insert': 'paste',
    'ctrl+pagedown': 'nextTab',
    'ctrl+pageup': 'prevTab',
    'ctrl+shift+w': 'closeTab',
  },
};

export function keyId(e: Pick<KeyboardEvent, 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'key'>): string {
  const mods = [e.ctrlKey && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift', e.metaKey && 'meta'].filter(Boolean);
  return [...mods, e.key.toLowerCase()].join('+');
}

export function keyAction(os: string, e: KeyboardEvent): KeyAction | undefined {
  return (KEYMAPS[os] ?? KEYMAPS['linux'])[keyId(e)];
}
