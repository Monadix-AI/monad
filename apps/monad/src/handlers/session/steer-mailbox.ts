import type { PendingSteerSource } from '#/agent/index.ts';

export class SessionSteerMailbox implements PendingSteerSource {
  private accepting = true;
  private pending: string[] = [];

  enqueue(text: string): boolean {
    return this.enqueueMany([text]);
  }

  enqueueMany(messages: string[]): boolean {
    if (!this.accepting) return false;
    this.pending.push(...messages);
    return true;
  }

  take(): string[] {
    return this.pending.splice(0);
  }

  close(): string[] {
    this.accepting = false;
    return this.take();
  }

  reopen(): void {
    this.accepting = true;
  }
}
