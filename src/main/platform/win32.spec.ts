import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { pickAgentPipe, powershell, shellCandidates, win32 } from './win32';

describe('pickAgentPipe', () => {
  it('prefers the OpenSSH agent service, then Pageant', () => {
    expect(pickAgentPipe(['foo', 'pageant.ana.abc123', 'openssh-ssh-agent'])).toBe('\\\\.\\pipe\\openssh-ssh-agent');
    expect(pickAgentPipe(['foo', 'pageant.ana.abc123'])).toBe('\\\\.\\pipe\\pageant.ana.abc123');
    expect(pickAgentPipe(['foo'])).toBeUndefined();
  });
});

describe('shellCandidates', () => {
  it('lists PowerShell 7 first and falls back to standard locations', () => {
    const list = shellCandidates({ SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', PATH: 'C:\\bin;' });
    expect(list.map((s) => s.name)).toEqual(['PowerShell 7', 'PowerShell 7', 'Windows PowerShell', 'cmd', 'Git Bash', 'WSL']);
    expect(list[1].path).toBe('C:\\bin\\pwsh.exe');
    expect(list[3].path).toBe('C:\\Windows\\System32\\cmd.exe');
  });
});

describe.runIf(process.platform === 'win32')('sshAgent', () => {
  it('finds an agent pipe by listing \\\\.\\pipe\\', async () => {
    const sock = process.env['SSH_AUTH_SOCK'];
    delete process.env['SSH_AUTH_SOCK']; // else it wins and the pipe listing is never reached
    const name = `pageant.estela-spec-${process.pid}`;
    const server = net.createServer();
    await new Promise<void>((done) => server.listen(`\\\\.\\pipe\\${name}`, done));
    try {
      expect(win32.sshAgent()).toBe(`\\\\.\\pipe\\${name}`);
    } finally {
      server.close();
      if (sock !== undefined) process.env['SSH_AUTH_SOCK'] = sock;
    }
  });
});

// Reads back what rdpCredential() wrote, so the test sees the bytes mstsc would get.
const READ_SCRIPT = `
$ErrorActionPreference = 'Stop'
$in = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding $false))
$target = $in.ReadLine()
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class EstelaCredRead {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
    public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredReadW(string target, uint type, uint flags, out IntPtr cred);
  public static string Read(string target) {
    IntPtr p;
    if (!CredReadW(target, 1, 0, out p)) return "MISSING";
    var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
    return c.UserName + "|" + Marshal.PtrToStringUni(c.CredentialBlob, (int)c.CredentialBlobSize / 2);
  }
}
'@
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[EstelaCredRead]::Read($target)
`;

describe.runIf(process.platform === 'win32')('rdpCredential', () => {
  const target = 'TERMSRV/estela-spec-localhost';
  const read = () => powershell(READ_SCRIPT, `${target}\n`).then((s) => s.trim());

  it('writes the credential verbatim and deletes it again', async () => {
    // Accented characters are the regression: [Console]::In decodes stdin with the console's
    // OEM code page, so "Contraseña" used to reach Credential Manager as "Contrase├▒a".
    const user = 'DOMINIO\\añoño';
    const password = 'Contraseña €ß 123';
    try {
      await win32.rdpCredential(target, user, password);
      expect(await read()).toBe(`${user}|${password}`);
    } finally {
      await win32.rdpCredential(target, user, null);
    }
    expect(await read()).toBe('MISSING');
  }, 60_000);
});
