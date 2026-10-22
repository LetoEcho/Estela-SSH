import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import type { LocalShell } from '../../shared/ipc';
import type { Platform } from './types';

const PIPES = '\\\\.\\pipe\\';

/**
 * Agent pipe to use: Windows' OpenSSH agent service, else Pageant (0.75+ also serves the
 * OpenSSH protocol on a pipe, so ssh2's pagent.exe helper is never needed).
 */
export function pickAgentPipe(pipes: string[]): string | undefined {
  const name = pipes.find((p) => p === 'openssh-ssh-agent') ?? pipes.find((p) => p.startsWith('pageant.'));
  return name && PIPES + name;
}

/** Candidate shells in menu order; the first existing one is the default. */
export function shellCandidates(env: Record<string, string | undefined>): LocalShell[] {
  const sys = env['SystemRoot'] ?? 'C:\\Windows';
  const pf = env['ProgramFiles'] ?? 'C:\\Program Files';
  const inPath = (exe: string) => (env['PATH'] ?? '').split(';').filter(Boolean).map((d) => path.win32.join(d, exe));
  return [
    ...[path.win32.join(pf, 'PowerShell', '7', 'pwsh.exe'), ...inPath('pwsh.exe')].map((p) => ({ path: p, name: 'PowerShell 7' })),
    { path: path.win32.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), name: 'Windows PowerShell' },
    { path: env['ComSpec'] ?? path.win32.join(sys, 'System32', 'cmd.exe'), name: 'cmd' },
    { path: path.win32.join(pf, 'Git', 'bin', 'bash.exe'), name: 'Git Bash' },
    { path: path.win32.join(sys, 'System32', 'wsl.exe'), name: 'WSL' },
  ];
}

/** Runs a PowerShell script (no user data in it) feeding `stdin`; resolves with stdout. */
export function powershell(script: string, stdin = ''): Promise<string> {
  const exe = path.win32.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const p = execFile(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true }, (err, out, errOut) =>
      err ? reject(new Error(errOut.trim() || err.message)) : resolve(out),
    );
    p.stdin?.end(stdin);
  });
}

// Credential Manager entry for mstsc. Every value (including the password) arrives on stdin,
// so nothing sensitive is on any command line. Stdin is read as UTF-8 through a StreamReader of
// our own: [Console]::In decodes redirected input with the console's OEM code page, which turns
// "Contraseña" into "Contrase├▒a". Setting [Console]::InputEncoding is not an option either
// (it calls SetConsoleCP, which fails without a real console).
const CRED_SCRIPT = `
$ErrorActionPreference = 'Stop'
$in = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding $false))
$action = $in.ReadLine()
$target = $in.ReadLine()
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class EstelaCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
    public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWriteW(ref CREDENTIAL c, uint flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredDeleteW(string target, uint type, uint flags);
  public static void Write(string target, string user, string password) {
    var c = new CREDENTIAL { Type = 1, TargetName = target, UserName = user, Persist = 1,
      CredentialBlobSize = (uint)(password.Length * 2), CredentialBlob = Marshal.StringToCoTaskMemUni(password) };
    try { if (!CredWriteW(ref c, 0)) throw new System.ComponentModel.Win32Exception(); }
    finally { Marshal.ZeroFreeCoTaskMemUnicode(c.CredentialBlob); }
  }
  public static void Delete(string target) { CredDeleteW(target, 1, 0); }
}
'@
if ($action -eq 'write') { $user = $in.ReadLine(); [EstelaCred]::Write($target, $user, $in.ReadLine()) }
else { [EstelaCred]::Delete($target) }
`;

export const win32: Platform = {
  sshAgent() {
    if (process.env['SSH_AUTH_SOCK']) return process.env['SSH_AUTH_SOCK'];
    try {
      return pickAgentPipe(fs.readdirSync(PIPES));
    } catch {
      return undefined;
    }
  },

  // DPAPI: always tied to the Windows user account.
  secretBackend: () => ({ name: 'dpapi', secure: safeStorage.isEncryptionAvailable() }),

  localShells() {
    const seen = new Set<string>();
    return shellCandidates(process.env).filter((s) => {
      if (seen.has(s.name) || !fs.existsSync(s.path)) return false;
      seen.add(s.name);
      return true;
    });
  },

  // ponytail: no OSC 7 hooks for local shells; their cwd is only needed by the SFTP panel, which is SSH-only.
  localShellSpawn(shellPath) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_')) env[k] = v;
    const args = /\\wsl\.exe$/i.test(shellPath) ? ['~'] : /\\bash\.exe$/i.test(shellPath) ? ['--login', '-i'] : [];
    return { file: shellPath, args, env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }, osc7: false };
  },

  processCwd: () => null,

  rdpClient() {
    const p = path.win32.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'mstsc.exe');
    return fs.existsSync(p) ? { kind: 'mstsc', path: p } : { error: 'No se encontró mstsc.exe (Conexión a Escritorio remoto).' };
  },

  async rdpCredential(target, user, password) {
    await powershell(CRED_SCRIPT, password === null ? `delete\n${target}\n` : `write\n${target}\n${user}\n${password}\n`);
  },

  async focusWindow(pid) {
    try {
      return (await powershell(`(New-Object -ComObject WScript.Shell).AppActivate(${Math.trunc(pid)})`)).trim() === 'True';
    } catch {
      return false;
    }
  },

  openInEditor(command, file) {
    // Through the shell so that "code" (code.cmd) and other .cmd launchers work; the file
    // is our own temp path and Windows paths cannot contain quotes.
    spawn(`${command} "${file}"`, { shell: true, stdio: 'ignore', windowsHide: true }).unref();
  },
};
