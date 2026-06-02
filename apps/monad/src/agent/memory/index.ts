// memory — short/long-term recall for the agent. v1 ships an in-memory implementation;
// a persistent backend (via @monad/store) is injected by the daemon later.

export interface Memory {
  remember(key: string, value: string): Promise<void>;
  recall(key: string): Promise<string | null>;
  forget(key: string): Promise<void>;
}

// Layered L1 memory (scope-isolated objective facts) lives alongside the trivial KV Memory above,
// which survives as a degenerate/test default. See ./layered.ts.
export * from './layered.ts';

export class InMemoryMemory implements Memory {
  private readonly map = new Map<string, string>();

  async remember(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }

  async recall(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }

  async forget(key: string): Promise<void> {
    this.map.delete(key);
  }
}
