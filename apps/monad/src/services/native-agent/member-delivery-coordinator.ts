export type NativeAgentTurnAdmission =
  | { admitted: false; reason: 'active' | 'gated' }
  | { admitted: true; completion: Promise<void> };

export interface NativeAgentTurnAdmissionInput {
  sessionId: string;
  memberInstanceId: string;
  isGated: () => boolean;
  start: () => Promise<void>;
  onSettled?: () => void | Promise<void>;
}

export class NativeAgentMemberDeliveryCoordinator {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly active = new Set<string>();
  private readonly idleCallbacks = new Map<string, Set<() => void | Promise<void>>>();

  private key(sessionId: string, memberInstanceId: string): string {
    return `${sessionId}\u0000${memberInstanceId}`;
  }

  async runExclusive<T>(sessionId: string, memberInstanceId: string, operation: () => T | Promise<T>): Promise<T> {
    const key = this.key(sessionId, memberInstanceId);
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => lock);
    this.tails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  admitTurn(input: NativeAgentTurnAdmissionInput): Promise<NativeAgentTurnAdmission> {
    return this.runExclusive(input.sessionId, input.memberInstanceId, () => {
      const key = this.key(input.sessionId, input.memberInstanceId);
      if (input.isGated()) return { admitted: false as const, reason: 'gated' as const };
      if (this.active.has(key)) return { admitted: false as const, reason: 'active' as const };
      this.active.add(key);
      let started: Promise<void>;
      try {
        started = input.start();
      } catch (error) {
        this.active.delete(key);
        throw error;
      }
      const completion = started.then(
        async () => {
          await this.settle(key, input);
        },
        async (error) => {
          await this.settle(key, input);
          throw error;
        }
      );
      return { admitted: true as const, completion };
    });
  }

  async runWhenIdle(
    sessionId: string,
    memberInstanceId: string,
    operation: () => void | Promise<void>
  ): Promise<boolean> {
    const key = this.key(sessionId, memberInstanceId);
    const runNow = await this.runExclusive(sessionId, memberInstanceId, () => {
      if (!this.active.has(key)) return true;
      const callbacks = this.idleCallbacks.get(key) ?? new Set();
      callbacks.add(operation);
      this.idleCallbacks.set(key, callbacks);
      return false;
    });
    if (runNow) await operation();
    return runNow;
  }

  isTurnActive(sessionId: string, memberInstanceId: string): boolean {
    return this.active.has(this.key(sessionId, memberInstanceId));
  }

  private async settle(key: string, input: NativeAgentTurnAdmissionInput): Promise<void> {
    let callbacks: Set<() => void | Promise<void>> | undefined;
    await this.runExclusive(input.sessionId, input.memberInstanceId, () => {
      this.active.delete(key);
      callbacks = this.idleCallbacks.get(key);
      this.idleCallbacks.delete(key);
    });
    await input.onSettled?.();
    for (const callback of callbacks ?? []) void callback();
  }
}

const coordinators = new WeakMap<object, NativeAgentMemberDeliveryCoordinator>();

export function nativeAgentMemberDeliveryCoordinatorFor(owner: object): NativeAgentMemberDeliveryCoordinator {
  let coordinator = coordinators.get(owner);
  if (!coordinator) {
    coordinator = new NativeAgentMemberDeliveryCoordinator();
    coordinators.set(owner, coordinator);
  }
  return coordinator;
}
