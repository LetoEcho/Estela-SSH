# Continuing the Windows work

Handover for developing Estela SSH on a Windows machine with Claude Code. Read `CLAUDE.md` first (conventions,
architecture, OS differences table); this file only covers what is specific to the Windows phase.

Talk to the user in Spanish. Code, comments and commit messages in English. UI text in Spanish.

## Where things stand

- Linux version complete (phases 1–4). Optional phase 5 (X11 forwarding, embedded RDP) not started: only on
  request, and give pros/cons first (including FreeRDP on Windows).
- The Windows layer was **written and compiled on Linux, never run on Windows**. Treat every Windows path as
  unverified until the user has tried it. Commit: "Windows platform layer: shells, agent pipes, DPAPI, mstsc RDP,
  packaging".
- On Linux only the zip target could be built (NSIS and portable need wine). On Windows `npm run dist:win` should
  build all three, and the CI matrix (`.github/workflows/ci.yml`) includes `windows-latest`. CI has never run yet.

## Setting up the Windows machine

1. Install Git for Windows and Node.js 24 (ships npm 11, needed for `allowScripts` in package.json).
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

## Verification checklist (nothing here has been tried yet)

Ordered by risk. Fix what fails, add a unit test for any non-visual logic that changes, then tick it off here.

- [ ] App starts from `npm start` and from the packaged zip / setup / portable exe; icon shows in the taskbar.
- [ ] Local terminals (💻＋): PowerShell 7, Windows PowerShell, cmd, Git Bash, WSL are listed only if installed;
      each opens, takes input, resizes, closes cleanly. (node-pty/ConPTY inside the packaged app is the main risk:
      check `resources\app.asar.unpacked\node_modules\node-pty\prebuilds\win32-x64` exists.)
- [ ] SSH with password, with a key file (`~/.ssh/id_ed25519` expands to `%USERPROFILE%\.ssh\...`), jump host.
- [ ] SSH agent: Windows OpenSSH agent service (`Get-Service ssh-agent`, keys added with `ssh-add`), and Pageant
      ≥ 0.75 when the service is not running.
- [ ] Secrets: saved password survives a restart; `secrets.json` does not contain it in clear; no "no keyring"
      warning (DPAPI is always available).
- [ ] SFTP panel follows the remote cwd; upload/download, drag from Explorer into the panel and from the panel to
      Explorer; a remote file named like `a:b?.txt` downloads as `a_b_.txt`.
- [ ] Remote editing: internal Monaco window, and external editor with command `code` (runs through the shell so
      `code.cmd` works); saving uploads.
- [ ] RDP to a Windows host: mstsc opens without asking for the password; after closing it, Credential Manager
      (`cmdkey /list`) has no `TERMSRV/<host>` entry left. Also: windowed size, multimonitor, clipboard, drive
      sharing (shares the drive holding the user profile), "via SSH" tunnel (cert name mismatch warning from mstsc is
      expected), RD Gateway, and the tab's "raise window" button (AppActivate).
- [ ] Tunnels L/R/D, multi-exec, split panes, search (Ctrl+Shift+F), session logs (default folder
      `Documents\Estela SSH logs`), auto-reconnect, light/dark theme, window state.
- [ ] Import `%USERPROFILE%\.ssh\config` and `known_hosts`.
- [ ] Shortcuts: Ctrl+Shift+C/V, Shift+Insert, Ctrl+PageUp/PageDown, Ctrl+Shift+E/O/W, Alt+arrows. If any clashes
      with Windows conventions, add a `win32` table in `keymap.ts` (with a test in `keymap.spec.ts`).
- [ ] `npm test` passes on Windows (tests needing `/usr/bin/script` and OpenSSH's sftp-server skip themselves;
      `test/tunnels.spec.ts` uses the real test server and may need a skip guard).
- [ ] CI green on both `ubuntu-latest` and `windows-latest`; artifacts contain `.exe` and `.zip`.

## Known risks and assumptions to check first

- **Credential script** (`CRED_SCRIPT` in win32.ts): PowerShell 5.1 reads its inputs with `[Console]::In.ReadLine()`
  while the script itself comes via `-EncodedCommand`. Assumed to work with redirected stdin; untested. `Add-Type`
  compiles C# on each call (≈1 s). The credential is type GENERIC (1), persistence SESSION, like
  `cmdkey /generic:TERMSRV/<host>`. If mstsc ignores it, try type DOMAIN_PASSWORD (2). The password must **never** go
  on a command line (`cmdkey /pass:` is not acceptable).
- **Existing credentials**: launching overwrites, and closing deletes, any `TERMSRV/<host>` entry the user saved in
  Windows themselves. Acceptable for now; mention it if the user relies on mstsc's own saved credentials.
- **mstsc lifetime**: assumed `mstsc.exe` stays alive for the whole session. If it hands off and exits early, the
  credential gets deleted before connecting and mstsc asks for the password.
- **Agent pipes**: found by `fs.readdirSync('\\\\.\\pipe\\')`. ssh2 treats `\\.\pipe\...` as an OpenSSH agent.
- **External editor**: `spawn(\`${command} "${file}"\`, { shell: true })`. The command is the user's own setting;
  the file is our temp path.
- **Local shells have no OSC 7 hook** on Windows (`osc7: false`, `processCwd` returns null). That is fine today
  because the SFTP panel only follows SSH panes.
- **No code signing**: SmartScreen warns ("Más información → Ejecutar de todas formas").

## Before/after pushing to GitHub

- Nothing else in the repo holds secrets: `release/`, `dist/` and `node_modules/` are git-ignored. Check
  `git status` before the first push anyway.
- Ask the user before pushing, creating releases or changing repo settings.
