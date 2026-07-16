import type { ContextNotice, MemorySuggestion } from '@monad/client-rtk';
import type { ContextUsagePayload } from '@monad/protocol';

// Same surfacing policy as the web's classifyContextNotice
// (apps/web/src/features/session/context-notice.ts): the handoff nudge surfaces, 'evicted' is
// routine housekeeping and stays quiet. Unlike the web's expiring toast, the TUI line persists —
// so drop it once live usage falls back under the nudge fraction (handoff or compaction landed).
export function latestHandoffNudge(
  notices: readonly ContextNotice[] | undefined,
  usage: ContextUsagePayload | undefined
): Extract<ContextNotice, { kind: 'handoff' }> | undefined {
  if (!notices) return undefined;
  for (let i = notices.length - 1; i >= 0; i--) {
    const notice = notices[i];
    if (notice?.kind !== 'handoff') continue;
    if (usage && usage.used / usage.contextLimit < notice.atFraction) return undefined;
    return notice;
  }
  return undefined;
}

export function activeMemorySuggestion(
  suggestion: MemorySuggestion | undefined,
  handledId: string | null
): MemorySuggestion | undefined {
  return suggestion && suggestion.id !== handledId ? suggestion : undefined;
}
