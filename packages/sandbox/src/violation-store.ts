import type { SandboxViolation } from '@monad/sdk-atom';

export interface SandboxViolationSnapshot {
  total: number;
  events: SandboxViolation[];
}

type SandboxViolationSubscriber = (snapshot: SandboxViolationSnapshot) => void;

function copyEvent(event: SandboxViolation): SandboxViolation {
  return { ...event };
}

export class SandboxViolationStore {
  private readonly events: SandboxViolation[] = [];
  private readonly subscribers = new Set<SandboxViolationSubscriber>();
  private total = 0;

  constructor(private readonly capacity = 100) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('violation store capacity must be positive');
  }

  append(event: SandboxViolation): void {
    this.total++;
    this.events.push(copyEvent(event));
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
    this.publish();
  }

  clear(): void {
    this.events.length = 0;
    this.publish();
  }

  snapshot(): SandboxViolationSnapshot {
    return { total: this.total, events: this.events.map(copyEvent) };
  }

  subscribe(subscriber: SandboxViolationSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  private publish(): void {
    for (const subscriber of this.subscribers) subscriber(this.snapshot());
  }
}

const sandboxViolationStore = new SandboxViolationStore();

export function sandboxViolationSnapshot(): SandboxViolationSnapshot {
  return sandboxViolationStore.snapshot();
}

export function clearSandboxViolations(): void {
  sandboxViolationStore.clear();
}

export function subscribeSandboxViolations(subscriber: SandboxViolationSubscriber): () => void {
  return sandboxViolationStore.subscribe(subscriber);
}

export function observeSandboxViolations(stream?: ReadableStream<SandboxViolation>): void {
  if (!stream) return;
  void (async () => {
    const reader = stream.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) return;
        sandboxViolationStore.append(next.value);
      }
    } finally {
      reader.releaseLock();
    }
  })().catch(() => {});
}
