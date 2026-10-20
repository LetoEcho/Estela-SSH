import { Injectable, signal } from '@angular/core';
import { estela } from './estela';

/** Transient messages shown as a toast (non-blocking, unlike alert()). */
@Injectable({ providedIn: 'root' })
export class NoticeService {
  readonly message = signal<string | null>(null);
  private timer?: ReturnType<typeof setTimeout>;

  constructor() {
    estela.on('app:notice', ({ message }) => this.show(message));
  }

  show(message: string): void {
    this.message.set(message);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.message.set(null), 6000);
  }
}
