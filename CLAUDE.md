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
| Local test SSH server (real bash + OpenSSH sftp-server, password `secret`) | `npm run test-server` (port 2222; `PORT=…`, `TEST_SHELL=/bin/sh` to try other shells) |

Windows packaging (NSIS + portable) arrives with the Windows phase.

## Layout

```
src/shared/    types + IPC contract shared by all processes (no runtime deps)
src/preload/   contextBridge → window.estela; bundled to one file (sandboxed preloads can only require 'electron')
src/main/      Electron main: ssh2, stores, dialogs, platform layer
  platform/    OS-specific code behind the Platform interface (types.ts); index.ts is the ONLY process.platform check
  store/       sessions.json, secrets.json (safeStorage), known_hosts (OpenSSH format)
  ssh/         SshShell (one per pane: target + jump clients, shell hook, SFTP), sftp helpers, transfer queue
  sftp-ipc.ts  SFTP / transfer / drag-out IPC handlers
src/renderer/  Angular 22 (standalone, zoneless, signals). Services hold state in signals; no NgRx.
test/          integration tests: in-process ssh2 servers; real-server.ts wraps real bash + sftp-server
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
- **Split panes**: a tab holds a binary layout tree (`Split`/`Pane` in tabs.service.ts). The xterm `Terminal` belongs
  to the `Pane`, not to the view: when splitting re-renders the tree, the view just re-parents `term.element`, so
  scrollback and connection survive.
- **cwd tracking (shell hook)**: after connecting, an exec channel reads `$SHELL`; when the first prompt goes quiet
  (300 ms) `ShellHook` types one space-prefixed line that installs an OSC 7 prompt hook (bash `PROMPT_COMMAND`, zsh
  `precmd_functions`, fish `fish_prompt`) and prints a private `OSC 777;estela;<pid>` marker. Output is swallowed until
  the marker, then the old prompt line is erased (`\r\e[2K`), so nothing shows. bash deletes the line from history only
  if it is the last entry (safe with `ignorespace`). Unknown shells (routers, appliances) get nothing typed at all.
  If the user types before the prompt settles, the hook is skipped; the SFTP panel offers "Activar seguimiento" to retry.
  sh/dash/ksh/csh only report the pid; the panel then polls `readlink /proc/<pid>/cwd` every 2 s while visible.
  The session's initial directory is applied through the same line (no visible `cd`).
- **SFTP**: one shared SFTP channel per pane for listings/ops; every transfer opens its own channel, so cancelling
  = closing it (fastGet/fastPut cannot be aborted otherwise). Partial files are removed on cancel. Overwrites are
  confirmed in the renderer (`transfer:conflicts`) before queueing. Queue concurrency is 2.
- **Drag & drop**: OS → panel uses `webUtils.getPathForFile` (preload). Panel → OS uses `webContents.startDrag`, which
  needs local files, so files only, ≤ 50 MB, downloaded to a temp dir first (best effort: if the mouse is released
  before the download ends, no drag starts). Temp dirs are removed when the window goes away.
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
| Panes | Ctrl+Shift+E split right, Ctrl+Shift+O split down, Ctrl+Shift+W close, Alt+arrows focus | TBD in keymap.ts |
| Packages | AppImage, deb, rpm | NSIS, portable |

## Testing notes

- `test/ssh.spec.ts` spins up ssh2 servers in-process (password, encrypted key, jump host, host-key change).
- `test/real.spec.ts` runs the shell hook and SFTP against real bash and OpenSSH's sftp-server (skipped if missing).
  zsh and fish hooks are not covered locally (not installed on the dev machine).
- Manual smoke tests can drive the app via `--remote-debugging-port` + CDP; use `ESTELA_USER_DATA` to avoid touching
  the real `~/.config/estela-ssh`. Synthetic DOM key events double characters in xterm; use CDP `Input.dispatchKeyEvent`.
- `package.json` `homepage` is a placeholder (deb packaging requires one); replace it when a repo URL exists.

## Roadmap

1. ✅ Sessions tree, tabs with colour/icon/status, SSH terminal, host keys, secrets, import/export, custom icons.
2. ✅ Split panes + SFTP panel following the terminal's cwd (OSC 7 hook, /proc fallback), transfers, chmod, D&D.
3. Multi-exec, tunnels, local terminal (node-pty, OSC 7 via rcfile), remote file editing (Monaco/external editor),
   RDP phase A, import ~/.ssh/config & known_hosts.
   Phase 3 status: only deps added (node-pty 1.1.0 with install script allowed; monaco-editor 0.57 whose `min/` is
   26 MB and has no AMD loader, so it must be bundled as ESM). Planned design: Pane target ssh|local; LocalPty with
   OSC 7 via bash --rcfile / zsh ZDOTDIR / fish --init-command; multi-exec in renderer (broadcast onData to selected
   panes); TunnelManager (L via forwardOut, R via forwardIn, D via own SOCKS5) reusing SshShell's connect chain;
   RDP tab kind launching FreeRDP (password typed on its "Password:" prompt, cert prompt forwarded to our dialog,
   ephemeral L tunnel for "via SSH"), focus with wmctrl/xdotool; editor in a second BrowserWindow;
   ~/.ssh/config + hashed known_hosts import. FreeRDP is not installed yet (`sudo apt install freerdp3-x11`).
4. Polish (keepalive/reconnect settings, themes, fonts, logging) and packaging.
5. Optional: X11 forwarding, embedded RDP.
Then: Windows platform layer + Windows CI/packages.
