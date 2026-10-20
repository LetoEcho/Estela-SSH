// Silent shell integration: makes the remote shell report its cwd (OSC 7) on every prompt
// and its pid (private OSC 777) once, without leaving traces on screen or in history.

const MARKER = /\x1b\]777;estela;(\d+)(?:\x1b\\|\x07)/;
const QUIET_MS = 300; // output silence that means "the prompt is up"
const MARKER_TIMEOUT_MS = 3000;

const osc7 = (line: string): HookScript => ({ line, osc7: true });

/** Prompt hooks that emit OSC 7; shared by the remote one-liner and the local rc files. */
export const OSC7_HOOK = {
  bash:
    `__estela_osc7() { printf '\\033]7;file://%s%s\\033\\\\' "\${HOSTNAME-}" "$PWD"; };` +
    ` case ";\${PROMPT_COMMAND-};" in *";__estela_osc7;"*) ;; *) PROMPT_COMMAND="__estela_osc7\${PROMPT_COMMAND:+;$PROMPT_COMMAND}";; esac;`,
  zsh:
    `__estela_osc7() { printf '\\033]7;file://%s%s\\033\\\\' "\${HOST-}" "$PWD" };` +
    ` (( \${precmd_functions[(I)__estela_osc7]} )) || precmd_functions+=(__estela_osc7);`,
  fish: `function __estela_osc7 --on-event fish_prompt; printf '\\e]7;file://%s%s\\e\\\\' "$hostname" "$PWD"; end;`,
};
const posixQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const reportPid = (pid: string) => `printf '\\033]777;estela;%s\\033\\\\' ${pid}`;

export interface HookScript {
  line: string;
  /** False for shells that only report their pid (cwd then comes from /proc). */
  osc7: boolean;
}

/**
 * The line typed into the shell, or null when the shell is unknown (e.g. a router CLI),
 * where typing anything could do damage. The leading space keeps it out of history
 * where HISTCONTROL/HIST_IGNORE_SPACE allow; bash also deletes it explicitly.
 */
export function hookScript(shellPath: string, initialDir?: string): HookScript | null {
  const shell = shellPath.trim().split('/').pop() ?? '';
  const cd = initialDir ? `; cd ${posixQuote(initialDir)}` : '';
  switch (shell) {
    case 'bash':
      return osc7(
        ` ${OSC7_HOOK.bash}` +
        // Only delete the last history entry if it is this very line (ignorespace may have skipped it).
        ` [[ $(HISTTIMEFORMAT= history 1) == *__estela_osc7* ]] && { set -- $(HISTTIMEFORMAT= history 1); history -d "$1"; }; set --;` +
        ` ${reportPid('"$$"')}${cd}`
      );
    case 'zsh':
      // ponytail: zsh keeps this line in history unless HIST_IGNORE_SPACE is set; zsh has no history delete builtin.
      return osc7(
        ` ${OSC7_HOOK.zsh}` +
        ` ${reportPid('"$$"')}${cd}`
      );
    case 'fish':
      return osc7(
        ` ${OSC7_HOOK.fish}` +
        ` printf '\\e]777;estela;%s\\e\\\\' $fish_pid${cd}`
      );
    case 'sh':
    case 'dash':
    case 'ksh':
    case 'mksh':
    case 'csh':
    case 'tcsh':
      // No prompt hook: report the pid only, the cwd is read from /proc.
      return { line: ` ${reportPid('$$')}${cd}`, osc7: false };
    default:
      return null;
  }
}

type HookState = 'waiting' | 'injecting' | 'done';

/**
 * Sits between the remote output and the terminal. Waits for the first prompt, types the hook,
 * swallows its echo until the marker arrives, then erases the old prompt line so the screen
 * looks untouched.
 */
export class ShellHook {
  pid?: number;
  private state: HookState = 'waiting';
  private osc7 = false;
  private buffer = '';
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly script: Promise<HookScript | null>,
    private readonly write: (s: string) => void,
    private readonly emit: (s: string) => void,
    private readonly done: (result: { pid?: number; installed: boolean }) => void,
  ) {}

  data(chunk: string): void {
    if (this.state !== 'injecting') {
      this.emit(chunk);
      if (this.state === 'waiting') this.restartQuietTimer();
      return;
    }
    this.buffer += chunk;
    const m = MARKER.exec(this.buffer);
    if (!m) return;
    this.pid = Number(m[1]);
    const rest = this.buffer.slice(m.index + m[0].length);
    this.finish(this.osc7);
    this.emit('\r\x1b[2K' + rest);
  }

  /** The user typed before the prompt was ready: injecting now would mix with their input. */
  userInput(): void {
    if (this.state === 'waiting') this.finish(false);
  }

  /** Explicit retry requested by the user (assumes an empty command line). */
  retry(): void {
    if (this.state === 'done') void this.inject();
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.state = 'done';
  }

  private restartQuietTimer(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.inject(), QUIET_MS);
  }

  private async inject(): Promise<void> {
    const script = await this.script;
    if (this.state === 'injecting') return;
    if (!script) return this.finish(false);
    this.state = 'injecting';
    this.osc7 = script.osc7;
    this.buffer = '';
    this.write(script.line + '\n');
    this.timer = setTimeout(() => {
      // Never lose output: give back whatever was held and stop hiding.
      const held = this.buffer;
      this.finish(false);
      this.emit(held);
    }, MARKER_TIMEOUT_MS);
  }

  private finish(installed: boolean): void {
    clearTimeout(this.timer);
    this.state = 'done';
    this.buffer = '';
    this.done({ pid: this.pid, installed });
  }
}
