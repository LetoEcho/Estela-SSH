# Estela SSH

SSH (and later RDP) desktop client in the spirit of MobaXterm, for personal use. Electron + Angular + ssh2 + xterm.js.
Linux first; Windows comes after the Linux version is complete.

Talk to the user in Spanish. Code, comments and commit messages in English. UI text in Spanish.

## Commands

| What | Command |
|---|---|
| Dev (ng serve + esbuild watch + Electron) | `npm run dev` — restart it after main/preload changes |
| Production build (renderer + main + preload) | `npm run build` |
| Run the built app | `npm start` |
| Unit + integration tests (vitest) | `npm test` |
| Type check everything | `npm run typecheck` |
| Linux packages (AppImage, deb, rpm → `release/`) | `npm run dist:linux` (rpm needs `rpmbuild`: `sudo apt install rpm`) |
| Isolated data dir (tests, experiments) | `ESTELA_USER_DATA=/some/dir npm start` |

Windows packaging (NSIS + portable) arrives with the Windows phase.

## Layout

```
src/shared/    types + IPC contract shared by all processes (no runtime deps)
src/preload/   contextBridge → window.estela; bundled to one file (sandboxed preloads can only require 'electron')
src/main/      Electron main: ssh2, stores, dialogs, platform layer
  platform/    OS-specific code behind the Platform interface (types.ts); index.ts is the ONLY process.platform check
  store/       sessions.json, secrets.json (safeStorage), known_hosts (OpenSSH format)
  ssh/         SshShell: one per pane, owns target + jump-host clients
src/renderer/  Angular 22 (standalone, zoneless, signals). Services hold state in signals; no NgRx.
test/          integration tests against in-process ssh2 servers (no Docker needed)
```

## Architecture decisions

- **Security**: contextIsolation, sandbox, no nodeIntegration. The renderer is a trust boundary: every IPC argument is
  validated in `src/main/ipc.ts` / `src/shared/session.ts`. Channels are allow-listed in the preload (`INVOKE_CHANNELS`,
  `SEND_CHANNELS`, `EVENT_CHANNELS` — `satisfies` keeps them in sync with the types).
- **Production renderer** is served over `app://estela/` with a strict CSP set by the protocol handler. Angular's
  critical-CSS inlining is disabled because it relies on an inline `onload` handler the CSP blocks.
- **IPC contract** lives in `src/shared/ipc.ts`: `InvokeApi` (request/response), `SendApi` (hot path, e.g. keystrokes),
  `EventApi` (main → renderer). Main-process questions to the user (host keys, passwords) go through `Prompts`.
- **One ssh2 `Client` per pane** (as MobaXterm). Jump hosts are references to other sessions, chained via `forwardOut`.
- **ssh2 `readyTimeout` is 0** because it counts the time the user spends answering prompts; TCP connect has its own 15 s timeout.
- **Auth flow** (`AuthFlow` in connection.ts): session method first, then password / keyboard-interactive fallback,
  max 3 password tries. Secrets the user asks to remember are saved only after auth succeeds.
- **Secrets** are encrypted with Electron `safeStorage` in `secrets.json`, separate from `sessions.json`, so exports
  never contain them. If the backend is `basic_text`, nothing is stored until the user explicitly accepts.
- **Host keys**: own `known_hosts` in OpenSSH format. Any mismatch for a known host is treated as "changed" (serious warning).
- **Portability of sessions.json**: key paths under home are stored as `~/...`; custom icons (.ico/.png/.svg ≤ 512 KB)
  are embedded as data: URLs so an export is self-contained.
- **Paths**: remote paths always `path.posix`; local paths use `path` (see `src/main/paths.ts`).
- **Keyboard shortcuts**: one table per OS in `src/renderer/app/keymap.ts` (no scattered OS checks in the UI).
- **Packaging**: only `ssh2` is a runtime dependency; everything for the renderer is a devDependency (bundled by Angular).
- npm 11 `allowScripts` in package.json: esbuild/electron-winstaller scripts allowed; ssh2/cpu-features native builds
  denied (ssh2 works in pure JS).

## OS differences

| Concern | Linux | Windows (pending) |
|---|---|---|
| SSH agent | `SSH_AUTH_SOCK` | Pageant or `\\.\pipe\openssh-ssh-agent` |
| Secret storage | safeStorage → libsecret/KWallet; warn on `basic_text` | safeStorage → DPAPI |
| Terminal copy/paste | Ctrl+Shift+C/V, Shift+Insert, copy on select, right-click paste | TBD in keymap.ts |
| Packages | AppImage, deb, rpm | NSIS, portable |

## Testing notes

- `test/ssh.spec.ts` spins up ssh2 servers in-process (password, encrypted key, jump host, host-key change).
- Manual smoke tests can drive the app via `--remote-debugging-port` + CDP; use `ESTELA_USER_DATA` to avoid touching
  the real `~/.config/estela-ssh`.
- `package.json` `homepage` is a placeholder (deb packaging requires one); replace it when a repo URL exists.

## Roadmap

1. ✅ Sessions tree, tabs with colour/icon/status, SSH terminal, host keys, secrets, import/export, custom icons.
2. Split panes + SFTP panel following the terminal's cwd (OSC 7 hook, /proc fallback).
3. Multi-exec, tunnels, local terminal (node-pty), editor (Monaco/external), RDP phase A, import ~/.ssh/config & known_hosts.
4. Polish (keepalive/reconnect settings, themes, fonts, logging) and packaging.
5. Optional: X11 forwarding, embedded RDP.
Then: Windows platform layer + Windows CI/packages.
