import type { PendingSteer, PendingSteerSource } from '#/agent/index.ts';

export class SessionSteerMailbox implements PendingSteerSource {
  private accepting = true;
  private pending: PendingSteer[] = [];

  enqueue(message: PendingSteer): boolean {
    return this.enqueueMany([message]);
  }

  enqueueMany(messages: readonly PendingSteer[]): boolean {
    if (!this.accepting) return false;
    this.pending.push(...messages);
    return true;
  }

  take(): PendingSteer[] {
    return this.pending.splice(0);
  }

  close(): PendingSteer[] {
    this.accepting = false;
    return this.take();
  }

  reopen(): void {
    this.accepting = true;
  }
}
