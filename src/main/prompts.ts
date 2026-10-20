import { randomUUID } from 'node:crypto';
import type { AuthAnswer, ChoicePrompt, EventApi, HostKeyAnswer } from '../shared/ipc';

type PromptChannel = 'prompt:hostkey' | 'prompt:auth' | 'prompt:choice';
type Emit = <K extends PromptChannel>(ch: K, payload: EventApi[K]) => void;

/** Main-process questions to the user (host keys, passwords) awaiting a 'prompt:answer' from the renderer. */
export class Prompts {
  private pending = new Map<string, (raw: unknown) => void>();

  constructor(private readonly emit: Emit) {}

  hostKey(p: Omit<EventApi['prompt:hostkey'], 'promptId'>): Promise<HostKeyAnswer> {
    return this.ask('prompt:hostkey', p, (raw) => (raw === 'once' || raw === 'save' ? raw : 'reject'));
  }

  auth(p: Omit<EventApi['prompt:auth'], 'promptId'>): Promise<AuthAnswer> {
    return this.ask('prompt:auth', p, (raw) => {
      const a = raw as { value?: unknown; save?: unknown } | null;
      return a && typeof a.value === 'string' ? { value: a.value, save: a.save === true } : null;
    });
  }

  choice(p: ChoicePrompt): Promise<string | null> {
    return this.ask('prompt:choice', p, (raw) => (p.choices.some((c) => c.value === raw) ? (raw as string) : null));
  }

  answer(promptId: string, raw: unknown): void {
    this.pending.get(promptId)?.(raw);
    this.pending.delete(promptId);
  }

  /** Renderer reloaded or closed: everything pending is a "no". */
  cancelAll(): void {
    for (const resolve of this.pending.values()) resolve(null);
    this.pending.clear();
  }

  private ask<T, K extends PromptChannel>(ch: K, p: object, sanitize: (raw: unknown) => T): Promise<T> {
    const promptId = randomUUID();
    return new Promise<T>((resolve) => {
      this.pending.set(promptId, (raw) => resolve(sanitize(raw)));
      this.emit(ch, { ...p, promptId } as EventApi[K]);
    });
  }
}
