# Estela SSH

SSH, SFTP and RDP desktop client in the spirit of MobaXterm, for personal use. Electron + Angular + ssh2 + xterm.js.
Linux and Windows (Windows layer written on Linux; verify on a real Windows machine — see docs/WINDOWS.md).

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
| Regenerate the app icon from build/icon.svg | `npx electron scripts/make-icon.cjs` (writes build/icon.png, 512×512) |
| Local test SSH server (real bash + OpenSSH sftp-server, password `secret`) | `npm run test-server` (port 2222; `PORT=…`, `TEST_SHELL=/bin/sh` to try other shells) |
| Windows packages (NSIS setup, portable, zip → `release/`) | `npm run dist:win` — on Linux, nsis/portable need `wine`; `npx electron-builder --win zip --x64` works without it |

## Layout

```
src/shared/    types + IPC contract shared by all processes (no runtime deps)
src/preload/   contextBridge → window.estela; bundled to one file (sandboxed preloads can only require 'electron')
src/main/      Electron main: ssh2, stores, dialogs, platform layer
  platform/    OS-specific code behind the Platform interface (types.ts); index.ts is the ONLY process.platform check
  store/       sessions.json, secrets.json (safeStorage), known_hosts (OpenSSH format)
  ssh/         SshConnection (jump chain + auth) → SshShell (pane), sftp helpers, transfer queue, tunnels, socks5
  local/       LocalPty (node-pty) for local terminals
  rdp/         FreeRDP args / mstsc .rdp file builders and the launcher (external window)
  editor.ts    remote file editing (internal Monaco window or external editor + upload on save)
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
- **ssh2 `readyTimeout` is 0** because it counts the time the user spends answering prompts. Instead: TCP connect
  timeout 15 s, and an SSH handshake timeout of 20 s that stops when the server presents its host key.
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
- **Tunnels**: each tunnel owns its own `SshConnection` (stopping one never touches a terminal). L = local server +
  `forwardOut`, R = `forwardIn` + 'tcp connection', D = our minimal SOCKS5 (no auth, CONNECT only). `autoStart`
  tunnels start once per app run after the UI loads (so host-key/password prompts can be answered). They survive a
  renderer reload and stop when the main window closes.
- **Local terminals**: node-pty (N-API, so no per-Electron rebuild; must stay `external` in esbuild). OSC 7 without
  typing anything: bash `--rcfile` (sources ~/.bashrc; Debian still reads /etc/bash.bashrc), zsh `ZDOTDIR` chain,
  fish `--init-command`. The renderer may only open shells listed by `platform.localShells()`.
- **Multi-exec**: renderer only. Input typed in a selected pane is written to every selected, connected pane (any tab).
- **RDP (phase A)**: external FreeRDP 3 window. Password via stdin (`/from-stdin:force`), never in argv. FreeRDP
  cannot ask about certificates without a TTY: it prints "Certificate details … Thumbprint" and aborts; we parse it,
  ask with our own dialog (first use / CHANGED warning), store the SHA-256 in `rdp-certs.json` (keyed by the real
  host:port) and relaunch with `/cert:fingerprint:sha256:…` — so only that certificate is accepted, also through
  tunnels. "Via SSH" = an ephemeral local forward on a free port, closed when FreeRDP exits. RD Gateway reuses the
  server credentials. Password saved (if asked) after 15 s alive. Raise window: xdotool or wmctrl (X11 only).
- **Editor**: second `BrowserWindow` (same preload/security) with `#editor=<id>`; it may only call `editor:load` /
  `editor:save`. Monaco is lazy-loaded; its CSS is the prebuilt `min/…/editor.main.css` emitted as a non-injected
  `monaco.css` bundle (Angular does not inject CSS imported from lazy chunks). Unsaved changes → `will-prevent-unload`
  confirmation. External editor: private temp copy, `fs.watch`, upload on change; max 5 MB, binary files refused.
- **OpenSSH import**: `~/.ssh/config` with first-match-wins semantics, `Host *` defaults, ProxyJump chains (hops become
  sessions), duplicates skipped; Include/Match/ProxyCommand ignored. known_hosts lines (incl. hashed `|1|`) are appended
  to ours; @cert-authority/@revoked skipped.
- **Settings** (`settings.json`, validated/clamped in `src/shared/settings.ts`): theme (system/dark/light), font,
  size, scrollback, copy-on-select, right-click paste (else a small context menu), SSH keepalive, auto-reconnect,
  log dir, editor. The renderer's `SettingsService` applies them live (theme via `data-theme` on <html> + CSS vars,
  xterm options on open terminals, Monaco theme in editor windows).
- **Auto-reconnect** (renderer, TabsService): only for SSH panes ending in `error` that is not auth/host-key/cancel;
  delays 2/4/8/16/30 s, then gives up; R reconnects at once. A normal `exit` (status `closed`) never reconnects.
- **Session logs**: per SSH session (`log: true`), written by main to `<logDir>/<name>-<UTC stamp>.log` with escape
  sequences stripped (`SessionLog` holds back escapes split across chunks).
- **Window state**: main window bounds/maximized saved in `window.json`, ignored if off-screen.
- **Paths**: remote paths always `path.posix`; local paths use `path` (see `src/main/paths.ts`).
- **Keyboard shortcuts**: one table per OS in `src/renderer/app/keymap.ts` (no scattered OS checks in the UI).
- **RDP on Windows**: mstsc with a temp `.rdp` file (UTF-16 + BOM). The password goes to Credential Manager
  (`TERMSRV/<host>`, generic, session persistence) through a PowerShell `CredWriteW` P/Invoke whose inputs all arrive
  on stdin (script passed with `-EncodedCommand`, no user data in it); the entry is deleted when mstsc exits.
  mstsc shows its own certificate dialogs, so no pinning there. Raise window: `WScript.Shell.AppActivate(pid)`.
- **Windows SSH agent**: `SSH_AUTH_SOCK`, else the `openssh-ssh-agent` pipe, else Pageant's own pipe (`pageant.*`,
  Pageant ≥ 0.75), found by listing `\\.\pipe\`. ssh2's pagent.exe helper is never used.
- **Windows file names**: remote names are made valid locally with `localName()` (paths.ts) on download/edit/drag.
- **Portable build**: `PORTABLE_EXECUTABLE_DIR` set → data in `<exe dir>/estela-ssh-data` (DPAPI secrets stay
  tied to the Windows user, so they do not travel with it).
- **Packaging**: `npmRebuild: false` (natives are N-API prebuilds or optional), which also allows building Windows
  packages from Linux. Only `ssh2` and `node-pty` are runtime dependencies; everything for the renderer is a devDependency (bundled by Angular).
- npm 11 `allowScripts` in package.json: esbuild/electron-winstaller scripts allowed; ssh2/cpu-features native builds
  denied (ssh2 works in pure JS).

## OS differences

| Concern | Linux | Windows |
|---|---|---|
| SSH agent | `SSH_AUTH_SOCK` | `SSH_AUTH_SOCK`, `\\.\pipe\openssh-ssh-agent`, Pageant pipe |
| Secret storage | safeStorage → libsecret/KWallet; warn on `basic_text` | safeStorage → DPAPI |
| Terminal copy/paste | Ctrl+Shift+C/V, Shift+Insert, copy on select, right-click paste | same (as Windows Terminal) |
| Panes | Ctrl+Shift+E split right, Ctrl+Shift+O split down, Ctrl+Shift+W close, Alt+arrows focus | same |
| Local shells | /etc/shells (+ $SHELL first), OSC 7 via rc files | PowerShell 7, Windows PowerShell, cmd, Git Bash, WSL (no OSC 7) |
| cwd of a local process | /proc/<pid>/cwd | not available (unused: SFTP is SSH-only) |
| RDP client | xfreerdp3 / xfreerdp / sdl-freerdp3 | mstsc + .rdp + CredWrite via stdin |
| Raise RDP window | xdotool or wmctrl (X11; not Wayland) | AppActivate by pid |
| External editor | spawn command + file, detached | through the shell (so `code.cmd` works) |
| Downloaded file names | as on the server | invalid characters → `_` (`localName`) |
| Packages | AppImage, deb (recommends freerdp3-x11), rpm (recommends freerdp; needs `rpmbuild`) | NSIS, portable, zip |

## Testing notes

- `test/ssh.spec.ts` spins up ssh2 servers in-process (password, encrypted key, jump host, host-key change).
- `test/real.spec.ts` runs the shell hook and SFTP against real bash and OpenSSH's sftp-server (skipped if missing).
- `test/tunnels.spec.ts` runs L/R/D tunnels end to end against the real test server (which also forwards ports).
- RDP was verified by hand against `freerdp-shadow-cli3` (package freerdp3-shadow-x11, extracted with
  `apt-get download`, `/sam-file` with an NT hash). It writes its own cert to ~/.config/freerdp/shadow — clean up.
  zsh and fish hooks are not covered locally (not installed on the dev machine).
- Manual smoke tests can drive the app via `--remote-debugging-port` + CDP; use `ESTELA_USER_DATA` to avoid touching
  the real `~/.config/estela-ssh`. Synthetic DOM key events double characters in xterm; use CDP `Input.dispatchKeyEvent`.
- `package.json` `homepage` is a placeholder (deb packaging requires one); replace it when a repo URL exists.

## Roadmap

1. ✅ Sessions tree, tabs with colour/icon/status, SSH terminal, host keys, secrets, import/export, custom icons.
2. ✅ Split panes + SFTP panel following the terminal's cwd (OSC 7 hook, /proc fallback), transfers, chmod, D&D.
3. ✅ Multi-exec, tunnels (L/R/D + auto start), local terminal, remote editing (Monaco / external), RDP phase A
   (FreeRDP, certificate pinning, via SSH), import ~/.ssh/config & known_hosts, settings dialog.
4. ✅ Settings (theme, fonts, scrollback, copy/paste behaviour, keepalive, auto-reconnect), terminal search
   (Ctrl+Shift+F), session logs, handshake timeout, window state, app icon, Linux packaging metadata.
5. Optional: X11 forwarding, embedded RDP (give pros/cons first, incl. FreeRDP on Windows).
W. ✅ (untested on real Windows) Windows platform layer, mstsc RDP, CI matrix with windows-latest, NSIS/portable/zip.
