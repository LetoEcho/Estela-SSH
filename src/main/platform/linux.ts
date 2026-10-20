import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeStorage } from 'electron';
import { OSC7_HOOK } from '../ssh/shell-hook';
import type { Platform, ShellSpawn } from './types';

const SKIP_SHELLS = new Set(['rbash', 'nologin', 'false', 'git-shell', 'tmux', 'screen']);
const RDP_CLIENTS = ['xfreerdp3', 'xfreerdp', 'sdl-freerdp3', 'sdl-freerdp'];

/** `which` without spawning a process. */
export function findInPath(cmd: string, envPath = process.env['PATH'] ?? ''): string | null {
  for (const dir of envPath.split(':')) {
    const p = path.join(dir, cmd);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

/** Shell list from /etc/shells: existing, interactive, deduplicated by real path, $SHELL first. */
export function parseShells(etcShells: string, userShell: string | undefined, exists: (p: string) => string | null) {
  const seen = new Set<string>();
  const shells: { path: string; name: string }[] = [];
  for (const p of [userShell ?? '', ...etcShells.split('\n')].map((l) => l.trim())) {
    if (!p.startsWith('/') || SKIP_SHELLS.has(path.basename(p))) continue;
    const real = exists(p);
    if (!real || seen.has(real)) continue;
    seen.add(real);
    shells.push({ path: p, name: path.basename(p) });
  }
  return shells;
}

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_')) env[k] = v;
  return { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
}

export const linux: Platform = {
  sshAgent: () => process.env['SSH_AUTH_SOCK'] || undefined,

  secretBackend() {
    const name = safeStorage.getSelectedStorageBackend();
    return { name, secure: safeStorage.isEncryptionAvailable() && name !== 'basic_text' && name !== 'unknown' };
  },

  localShells() {
    let etc = '';
    try {
      etc = fs.readFileSync('/etc/shells', 'utf8');
    } catch {}
    const shells = parseShells(etc, process.env['SHELL'], (p) => {
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return fs.realpathSync(p);
      } catch {
        return null;
      }
    });
    return shells.length ? shells : [{ path: '/bin/sh', name: 'sh' }];
  },

  localShellSpawn(shellPath, hookDir): ShellSpawn {
    const env = cleanEnv();
    const name = path.basename(shellPath);
    fs.mkdirSync(hookDir, { recursive: true, mode: 0o700 });
    if (name === 'bash') {
      // /etc/bash.bashrc is still read with --rcfile on Debian/Ubuntu; we only replace ~/.bashrc.
      const rc = path.join(hookDir, 'bashrc');
      fs.writeFileSync(rc, `[ -f ~/.bashrc ] && . ~/.bashrc\n${OSC7_HOOK.bash}\n`);
      return { file: shellPath, args: ['--rcfile', rc, '-i'], env, osc7: true };
    }
    if (name === 'zsh') {
      // ZDOTDIR points at our dir; our files chain to the user's and then restore ZDOTDIR.
      const dir = path.join(hookDir, 'zsh');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '.zshenv'), '[ -f "$HOME/.zshenv" ] && . "$HOME/.zshenv"\n');
      fs.writeFileSync(path.join(dir, '.zshrc'), `ZDOTDIR="$HOME"\n[ -f "$HOME/.zshrc" ] && . "$HOME/.zshrc"\n${OSC7_HOOK.zsh}\n`);
      return { file: shellPath, args: ['-i'], env: { ...env, ZDOTDIR: dir }, osc7: true };
    }
    if (name === 'fish') return { file: shellPath, args: ['-i', '--init-command', OSC7_HOOK.fish], env, osc7: true };
    return { file: shellPath, args: ['-i'], env, osc7: false };
  },

  processCwd(pid) {
    try {
      return fs.readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  },

  rdpClient() {
    for (const c of RDP_CLIENTS) {
      const p = findInPath(c);
      if (p) return { path: p };
    }
    return { error: 'No se encontró FreeRDP. Instálalo con: sudo apt install freerdp3-x11 (o freerdp en Red Hat)' };
  },

  async focusWindow(pid) {
    // X11 only: Wayland does not let apps raise other apps' windows.
    if (process.env['XDG_SESSION_TYPE'] === 'wayland') return false;
    const xdotool = findInPath('xdotool');
    if (xdotool) {
      return new Promise((resolve) =>
        execFile(xdotool, ['search', '--pid', String(pid), 'windowactivate'], (err) => resolve(!err)),
      );
    }
    const wmctrl = findInPath('wmctrl');
    if (!wmctrl) return false;
    const list = await new Promise<string>((resolve) => execFile(wmctrl, ['-lp'], (_e, out) => resolve(out ?? '')));
    const win = list.split('\n').find((l) => l.split(/\s+/)[2] === String(pid))?.split(/\s+/)[0];
    if (!win) return false;
    return new Promise((resolve) => execFile(wmctrl, ['-i', '-a', win], (err) => resolve(!err)));
  },

  openInEditor(command, file) {
    const [cmd, ...args] = splitCommand(command);
    spawn(cmd, [...args, file], { detached: true, stdio: 'ignore', env: cleanEnv(), cwd: os.homedir() }).unref();
  },
};

/** Splits a command line honouring simple quotes: `code --wait "a b"` → ['code', '--wait', 'a b']. */
export function splitCommand(cmd: string): string[] {
  return [...cmd.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}
