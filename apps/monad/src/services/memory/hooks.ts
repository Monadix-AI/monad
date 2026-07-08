// The L1 memory lifecycle wiring, in ONE place so the daemon (main.ts) and the e2e share it (no
// drift between what ships and what's tested): recall + nudge on BeforeTurn, per-turn observe on
// AfterTurn (mem0), drop ephemeral session memory on SessionEnd.

import type { SessionId } from '@monad/protocol';
import type { HookDefinition } from '@monad/sdk-atom';
import type { MemoryService } from '#/services/memory/index.ts';

const MEMORY_NUDGE =
  'You have a `memory` tool. The index above shows what you already know — use action "view" to read ' +
  'a scope before relying on it, and "record"/"update"/"delete" to keep it accurate (scope "global" ' +
  'for facts about the user).';

export interface MemoryHookRegistry {
  registerHook(hook: HookDefinition): void;
}

/**
 * Register the memory lifecycle hooks on the daemon's hook registry. `extraContext` lets the daemon
 * fold in its own note-store block alongside recall (kept out of this module so it stays memory-only).
 */
export function registerMemoryHooks(
  registry: MemoryHookRegistry,
  memoryService: MemoryService,
  opts?: { extraContext?: (sessionId: string) => string | undefined }
): void {
  registry.registerHook({
    event: 'BeforeTurn',
    handler: async (input) => {
      const extra = opts?.extraContext?.(input.sessionId);
      const isSession = input.sessionId.startsWith('ses_');
      const recalled = isSession
        ? await memoryService.recallContext(input.sessionId as SessionId, input.prompt ?? '')
        : undefined;
      const nudge = isSession && memoryService.toolsActive() ? MEMORY_NUDGE : undefined;
      const ctx = [extra, recalled, nudge].filter((s): s is string => Boolean(s)).join('\n\n');
      return ctx ? { additionalContext: ctx } : undefined;
    }
  });
  registry.registerHook({
    event: 'AfterTurn',
    handler: (input) => {
      if (!input.sessionId.startsWith('ses_')) return undefined;
      memoryService.observeTurn(input.sessionId as SessionId);
      return undefined;
    }
  });
  registry.registerHook({
    event: 'SessionEnd',
    handler: (input) => {
      if (!input.sessionId.startsWith('ses_')) return undefined;
      void memoryService.endSession(input.sessionId as SessionId);
      return undefined;
    }
  });
}
