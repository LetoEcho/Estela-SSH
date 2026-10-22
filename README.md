# Estela SSH

SSH, SFTP, RDP and serial desktop client in the spirit of MobaXterm, for personal use.
Electron + Angular + ssh2 + xterm.js, on Linux and Windows.

The interface is in Spanish; the code and these docs are in English.

## What it does

**Sessions** live in a tree of folders you can drag things around in, each with its own colour and icon
(an emoji or an .ico/.png/.svg of your own). Double click connects. Sessions export to a single JSON file
that carries the custom icons but never the passwords.

**SSH terminals** in tabs, with split panes (a tab holds a layout tree, so splitting never drops a
connection or its scrollback), search, session logs with the escape sequences stripped, and
auto-reconnect for panes that die of a network error — never after a clean exit or a bad password.
Authentication by password, private key or agent, with jump hosts chained through other sessions.
Unknown host keys are asked about once and kept in an OpenSSH-format `known_hosts` of our own; a key
that changes is reported as the serious thing it is.

**SFTP** in a side panel that follows the terminal's current directory. It installs a silent OSC 7 hook
in the remote shell (bash, zsh and fish; unknown shells are left alone), so `cd` in the terminal moves
the panel. Transfers run in a queue of two, each in its own channel so cancelling really stops it,
with overwrite confirmation, drag & drop both ways, `chmod`, rename and delete.

**Tunnels** per session: local (`L`), remote (`R`) and a SOCKS5 proxy (`D`), each on its own connection
so stopping one never touches a terminal. Tunnels marked `auto` start with the app.

**Remote editing**: open a remote file in a built-in Monaco window, or in your own editor (VS Code,
anything) — the local copy is watched and uploaded on every change.

**Multi-exec**: type once, send to every pane you ticked, across tabs.

**Local terminals** through a real pty: your shells on Linux, and PowerShell, cmd, Git Bash and WSL
on Windows.

**Serial consoles** (COM / tty) as ordinary terminal tabs: the port list comes from the OS, and speed,
data bits, parity, stop bits and flow control (none, RTS/CTS or XON/XOFF) are per session, plus what
Enter sends (CR, LF or CR+LF) and a local echo for devices that do not echo by themselves.

**RDP** in an external window: FreeRDP on Linux, with its certificate pinned after you accept it once
and an option to reach the host through an SSH session; `mstsc` on Windows.

**Settings** that apply live: theme (system, dark or light), font and size, scrollback, copy on select,
right-click paste, SSH keepalive, auto-reconnect, log directory and editor.

It also imports your `~/.ssh/config` (first-match-wins, `Host *` defaults and `ProxyJump` chains become
jump hosts) and your `~/.ssh/known_hosts`.

## Keyboard

The same keys as Windows Terminal, on both systems.

| | |
|---|---|
| Copy / paste | `Ctrl+Shift+C` / `Ctrl+Shift+V`, `Shift+Insert` |
| Next / previous tab | `Ctrl+PageDown` / `Ctrl+PageUp` |
| Split right / down | `Ctrl+Shift+E` / `Ctrl+Shift+O` |
| Move between panes | `Alt+←↑↓→` |
| Close pane | `Ctrl+Shift+W` |
| Search in the terminal | `Ctrl+Shift+F` |
| DevTools | `F12` |

## Running it

Node 24 is required to build (Angular's CLI refuses anything older; the tests run on less, so a green
`npm test` says nothing about the build).

```sh
npm ci
npm run build
npm start
```

| | |
|---|---|
| Dev mode (ng serve + esbuild watch + Electron) | `npm run dev` |
| Tests | `npm test` |
| Type check | `npm run typecheck` |
| Linux packages → `release/` | `npm run dist:linux` (rpm needs `rpmbuild`) |
| Windows packages → `release/` | `npm run dist:win` |
| Isolated data directory | `ESTELA_USER_DATA=/some/dir npm start` |

The Windows build produces an installer, a portable `.exe` and a zip; the Linux one an AppImage, a deb
and an rpm. Nothing is code-signed, so Windows SmartScreen warns the first time.

**What it needs from the system:** an RDP session needs FreeRDP 3 on Linux (`freerdp3-x11`) and
`mstsc.exe` on Windows, both only when you actually open one. A serial session on Linux needs your user
in the `dialout` group. Everything else is self-contained: the native parts (ssh2, node-pty, serialport)
ship as N-API prebuilds, so there is nothing to compile.

**Where your data lives:** `~/.config/estela-ssh` on Linux, `%APPDATA%\estela-ssh` on Windows, and
`estela-ssh-data` next to the executable for the portable build. That is `sessions.json`, the encrypted
`secrets.json`, `known_hosts`, `settings.json` and the window state.

## Security

The renderer is treated as untrusted: context isolation and sandbox are on, node integration is off,
every IPC channel is allow-listed in the preload and every argument is validated in the main process.
In production the renderer is served over a custom protocol with a strict CSP.

Passwords and passphrases are only stored if you ask, and then through Electron's `safeStorage`
(libsecret/KWallet on Linux, DPAPI on Windows) in a file separate from the sessions, so an export never
contains them. If no keyring is available, nothing is stored until you accept that in so many words.
A password never reaches a command line: FreeRDP reads it from stdin, and the Windows RDP credential
goes to Credential Manager through a `CredWriteW` call whose every input arrives on stdin, and is
deleted when the session ends.

## Status

Phases 1 to 4 (sessions, terminals, SFTP, tunnels, multi-exec, local terminals, remote editing, RDP,
imports, settings, logs) and serial support are done. The Windows layer has been exercised on a real
Windows 11 machine; `docs/WINDOWS.md` records what was verified and what still needs hardware.
Optional next: X11 forwarding and embedded RDP.

A personal project, with no licence granted.
