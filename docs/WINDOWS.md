# Continuing the Windows work

Handover for developing Estela SSH on a Windows machine with Claude Code. Read `CLAUDE.md` first (conventions,
architecture, OS differences table); this file only covers what is specific to the Windows phase.

Talk to the user in Spanish. Code, comments and commit messages in English. UI text in Spanish.

## Where things stand

- Linux version complete (phases 1–4). Optional phase 5 (X11 forwarding, embedded RDP) not started: only on
  request, and give pros/cons first (including FreeRDP on Windows).
- The Windows layer was written and compiled on Linux. It has now been **run on a real Windows 11 machine**
  (26200, x64, Electron 44, Node 24): see the verification checklist below for what was exercised and how.
  One real bug came out of it (accents in the mstsc credential, fixed with a regression test); everything else
  worked as designed.
- CI (`.github/workflows/ci.yml`) has now run the whole matrix on Windows too; see the last checklist item.

## Setting up the Windows machine

1. Install Git for Windows and Node.js 24 (ships npm 11, needed for `allowScripts` in package.json).
   Node 24 is not optional: Angular 22's CLI refuses anything below v22.22.3 ("The Angular CLI requires a minimum
   Node.js version of v22.22.3 or v24.15.0 or v26.0.0") and `npm run build` stops there. Tests and typecheck do run
   on older Node, so a green `npm test` says nothing about the build.
2. Clone the repo. Keep LF line endings to avoid spurious diffs: `git config core.autocrlf false` before cloning,
   or set it in the clone and run `git checkout .`.
3. Set the repo-local git identity used so far: `git config user.name "LetoEcho"` and
   `git config user.email "172483139+LetoEcho@users.noreply.github.com"`.
4. `npm ci`. node-pty uses its bundled `prebuilds/win32-x64` (no Visual Studio needed). ssh2's optional native
   parts are denied in `allowScripts` on purpose (ssh2 works in pure JS).
5. `npm run typecheck`, `npm test`, `npm run build`, `npm start`.

| What | Command (PowerShell) |
|---|---|
| Dev mode | `npm run dev` |
| Isolated data dir | `$env:ESTELA_USER_DATA = "$env:TEMP\estela-test"; npm start` |
| Packages (setup, portable, zip → `release/`) | `npm run dist:win` |
| DevTools in the app | F12 |

Real user data lives in `%APPDATA%\estela-ssh`; the portable build uses `<exe dir>\estela-ssh-data`.

## Windows code map

| Concern | File |
|---|---|
| Everything OS-specific (shells, agent, DPAPI, mstsc, AppActivate, external editor) | `src/main/platform/win32.ts` |
| Platform selection (the only `process.platform` check in app code) | `src/main/platform/index.ts` |
| `.rdp` file for mstsc and the credential target name | `src/main/rdp/mstsc-file.ts` |
| mstsc launch flow (credential written → mstsc runs → credential deleted) | `src/main/rdp/rdp.ts` (`runMstsc`) |
| Valid local file names for downloads / drag-out / editing | `localName()` in `src/main/paths.ts` |
| Portable data dir | `src/main/main.ts` (`PORTABLE_EXECUTABLE_DIR`) |
| Keyboard shortcuts (Windows falls back to the Linux table) | `src/renderer/app/keymap.ts` |
| Packaging targets | `electron-builder.yml` (`win`, `nsis`, `portable`) |

## Verification checklist

Run on Windows 11 Pro 26200 (x64) on 2026-10-21. `[x]` = exercised and working, `[~]` = partly verified (what is
missing is spelled out), `[ ]` = still untried. Most of it was driven through the real IPC surface with
`--remote-debugging-port` + CDP against a throwaway `ESTELA_USER_DATA`, against a local ssh2 server backed by
Git for Windows' bash and `sftp-server.exe` (the repo's own `test/real-server.ts` is Linux-only: it needs
`/usr/bin/script`).

- [x] App starts from `npm start`, from `npm run dev` (ng serve on 4200 + esbuild watch + Electron; the watch
      rebuild after editing a main-process file works), and from all three packages: `win-unpacked` (what the zip
      contains), the NSIS setup (installed per user to `%LOCALAPPDATA%\Programs\estela-ssh`, shortcut created,
      runs, uninstalls clean) and the portable exe (which writes `estela-ssh-data` next to itself). The exe
      carries the generated icon.
- [x] Local terminals (💻＋): Windows PowerShell, cmd, Git Bash and WSL open, take input, resize and close
      cleanly; PowerShell 7 is correctly absent from the list on a machine without it. ConPTY works both from
      source and from the packaged app (`resources\app.asar.unpacked\node_modules\node-pty\prebuilds\win32-x64`
      is unpacked by electron-builder's smart unpack, no `asarUnpack` entry needed).
- [x] SSH with password, with a key file (absolute and `~/...`), and through a jump host. Unknown host key is
      asked once and written to `known_hosts` in OpenSSH format; the OSC 7 hook installs itself and the SFTP
      panel follows `cd`.
- [~] SSH agent: no OpenSSH agent service running and no Pageant on this machine, so the handshake with a real
      agent is untested. The discovery code is covered: `win32.spec.ts` creates a `\\.\pipe\pageant.*` pipe and
      checks `sshAgent()` finds it, which exercises the `readdirSync('\\\\.\\pipe\\')` that was the actual risk.
- [x] Secrets: a password saved on connect survives an app restart (no second prompt), `secrets.json` holds only
      DPAPI ciphertext, and `secrets:status` reports `{backend: dpapi, secure: true}` with no "no keyring" warning.
- [~] SFTP: home/list/mkdir/rename/delete, download, upload and the overwrite-conflict check all work against a
      real `sftp-server`. Of drag-out, everything up to the OS hand-off works: the file is downloaded to a temp
      dir and folders / missing files are refused with the right notice; the drop itself needs a real mouse
      (`webContents.startDrag` runs a blocking drag loop), as does dragging from Explorer into the panel.
      A remote file named `a:b?.txt` cannot be created on an NTFS-hosted test server, so `localName()` is only
      covered by `paths.spec.ts`; re-test it against a Linux host.
- [x] Remote editing: the internal Monaco window opens (`#editor=<id>`, and it is correctly refused any IPC
      other than `editor:load`/`editor:save`), saves upload; the external editor opens VS Code through the shell
      (`code` → `code.cmd`) and every change to the local copy is uploaded.
- [~] RDP: against a dead port, the whole mstsc flow works — temp `.rdp` written UTF-16+BOM with the expected
      fields, credential written to Credential Manager with the exact password (accents included, see below),
      "raise window" (AppActivate) returns true, and on exit the credential and the temp dir are both removed.
      **Not verified:** that mstsc actually consumes our GENERIC credential, which needs a real RDP host. Also
      untested for lack of a host: window size, multimonitor, clipboard, drive sharing, "via SSH", RD Gateway.
- [x] Tunnels L/R/D: all three reach `running` and really forward (an SSH banner comes back through the local
      forward, the remote forward and the SOCKS5 proxy). Split panes and the search box respond to
      Ctrl+Shift+E / Ctrl+Shift+F. Session logs land in `Documents\Estela SSH logs` with escapes stripped.
      Theme and window bounds persist across a restart (`settings.json`, `window.json`); `window.json` is only
      written on a graceful close, so killing the process loses it (by design).
- [x] Import `%USERPROFILE%\.ssh\config` (first-match-wins, `Host *` defaults, ProxyJump chain, `IdentityFile`
      stored as `~/...`) and `known_hosts` (18 lines merged, hashed entries included).
- [x] Shortcuts: reviewed against Windows Terminal; Ctrl+Shift+C/V, Shift+Insert, Ctrl+PageUp/PageDown,
      Ctrl+Shift+W/F and Alt+arrows all match it, and none collides with a reserved Windows shortcut
      (only Ctrl+Shift+Esc is, and we do not use it). No `win32` table needed in `keymap.ts`.
- [x] `npm test` passes on Windows: 78 passed, 5 skipped (only `test/real.spec.ts`, which needs `/usr/bin/script`
      and OpenSSH's `sftp-server`). `test/tunnels.spec.ts` runs fine and needs no skip guard.
- [x] CI green on both `ubuntu-latest` and `windows-latest` (Node 24): `npm ci`, typecheck, tests, build and
      `electron-builder` all pass on Windows, and the artifact uploads with `if-no-files-found: error`, so the
      `release/*.exe` and `release/*.zip` globs really matched (369 MB for `estela-ssh-windows-latest`).
      The workflow triggers on both `push` and `pull_request`, so a branch with a PR builds the same commit twice.
      That second run is what caught the one flaky test: `session-log.spec.ts` slept 50 ms after `close()` and read
      the file before the `WriteStream` had flushed on a loaded runner. `SessionLog.close()` now returns a promise
      that resolves on flush and the test awaits it, so the assertion no longer depends on wall-clock time.

## Known risks and assumptions — status after the first Windows run

- **Credential script** (`CRED_SCRIPT` in win32.ts): works. Redirected stdin plus `-EncodedCommand` is fine, and
  `Add-Type` costs ~1 s per call (two calls per RDP session: write and delete).
  **One bug was found and fixed here**: `[Console]::In` decodes redirected stdin with the console's OEM code page
  (CP850 on a Spanish Windows), so `Contraseña` reached Credential Manager as `Contrase├▒a` and mstsc would have
  got a wrong password for any non-ASCII credential. The script now wraps `OpenStandardInput()` in its own UTF-8
  `StreamReader`. Setting `[Console]::InputEncoding` instead is not an option: it calls `SetConsoleCP`, which needs
  a real console. Covered by `win32.spec.ts > rdpCredential` (Windows-only), which writes through
  `win32.rdpCredential` and reads the blob back with `CredReadW`.
- **Credential type**: still GENERIC (1), persistence SESSION. Whether mstsc consumes it needs a real RDP host.
  If it does not, try DOMAIN_PASSWORD (2) — note that Windows' own mstsc saves its credentials as type 2.
- **Existing credentials**: **not a problem after all.** Credentials are keyed by (target, type), so our
  GENERIC `TERMSRV/<host>` and a user's own DOMAIN_PASSWORD `TERMSRV/<host>` coexist, and `CredDeleteW(target, 1)`
  only removes ours. Verified by writing both types on the same target and deleting one. What is still open is
  which of the two mstsc picks when both exist.
- **mstsc lifetime**: `mstsc.exe` stayed alive until its window closed, and `rdp:status` went
  starting → running → exited in step with it, so the credential is deleted at the right moment. Only checked
  against a refused connection; a real session may still behave differently.
- **Agent pipes**: `fs.readdirSync('\\\\.\\pipe\\')` works. ssh2 treats `\\.\pipe\...` as an OpenSSH agent.
- **External editor**: works; `code` resolves to `code.cmd` through the shell.
- **Local shells have no OSC 7 hook** on Windows (`osc7: false`, `processCwd` returns null). That is fine today
  because the SFTP panel only follows SSH panes.
- **Default font**: `fontFamily` starts with DejaVu Sans Mono / Liberation Mono, which no Windows machine has; it
  falls through to Cascadia Mono. Cosmetic, left alone.
- **No code signing**: SmartScreen warns ("Más información → Ejecutar de todas formas").

## Before/after pushing to GitHub

- Nothing else in the repo holds secrets: `release/`, `dist/` and `node_modules/` are git-ignored. Check
  `git status` before the first push anyway.
- Ask the user before pushing, creating releases or changing repo settings.
