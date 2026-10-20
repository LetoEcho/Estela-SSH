import type { ITheme } from '@xterm/xterm';

export const TERMINAL_THEMES: Record<'dark' | 'light', ITheme> = {
  dark: {
    background: '#1e1f22',
    foreground: '#dcddde',
    cursor: '#dcddde',
    selectionBackground: '#4a90d966',
  },
  // xterm's default palette is unreadable on white (yellow, bright white): use a light-friendly one.
  light: {
    background: '#ffffff',
    foreground: '#1f2328',
    cursor: '#1f2328',
    selectionBackground: '#0969da40',
    black: '#24292f',
    red: '#cf222e',
    green: '#116329',
    yellow: '#7d4e00',
    blue: '#0969da',
    magenta: '#8250df',
    cyan: '#1b7c83',
    white: '#6e7781',
    brightBlack: '#57606a',
    brightRed: '#a40e26',
    brightGreen: '#1a7f37',
    brightYellow: '#633c01',
    brightBlue: '#218bff',
    brightMagenta: '#a475f9',
    brightCyan: '#3192aa',
    brightWhite: '#8c959f',
  },
};
