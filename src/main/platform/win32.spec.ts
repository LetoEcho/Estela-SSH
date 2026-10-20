import { describe, expect, it } from 'vitest';
import { pickAgentPipe, shellCandidates } from './win32';

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
