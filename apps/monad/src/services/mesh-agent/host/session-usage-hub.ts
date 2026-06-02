import type { MeshAgentSessionUsage } from '@monad/protocol';
import type { MeshAgentSessionUsageListener } from './host-types.ts';

export class MeshAgentSessionUsageHub {
  private readonly listeners = new Map<string, Set<MeshAgentSessionUsageListener>>();

  publish(id: string, usage: MeshAgentSessionUsage): boolean {
    const listeners = this.listeners.get(id);
    if (!listeners?.size) return false;
    for (const listener of listeners) listener(usage);
    return true;
  }

  subscribe(id: string, listener: MeshAgentSessionUsageListener): { dispose: () => void } {
    const listeners = this.listeners.get(id) ?? new Set<MeshAgentSessionUsageListener>();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    return {
      dispose: () => {
        listeners.delete(listener);
        if (listeners.size === 0) this.listeners.delete(id);
      }
    };
  }
}
