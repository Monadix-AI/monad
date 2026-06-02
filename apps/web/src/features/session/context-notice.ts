import type { MemoryScopeQuery, UIItem } from '@monad/protocol';

interface MemorySuggestionData {
  scope: { kind: MemoryScopeQuery['scopeKind']; id: MemoryScopeQuery['scopeId'] };
  facts: string[];
}

/** A toast-worthy context notice, or a memory-fact save prompt — the classification of one live UI
 *  item, decoupled from the effect that renders it so the branching is unit-testable without a DOM. */
export type ContextNotice =
  | { kind: 'toast'; text: string }
  | { kind: 'suggestion'; scope: MemorySuggestionData['scope']; facts: string[] };

function memorySuggestionData(item: Extract<UIItem, { kind: 'custom' }>): MemorySuggestionData | null {
  if (item.name !== 'memory.suggestion') return null;
  const data = item.data as Partial<MemorySuggestionData> | undefined;
  if (!data?.scope || !Array.isArray(data.facts) || data.facts.length === 0) return null;
  return { scope: data.scope, facts: data.facts };
}

/** Decide how a live UI item should surface, or `null` to ignore it. Both event kinds are projected
 *  server-side (ui-projection-interaction-events.ts) and never render inline in the transcript, so
 *  this is the only place they reach the user.
 *
 *  - `system` + `level:'warn'` (context.handoff_suggested) → a plain toast. `level:'info'`
 *    (context.evicted) is deliberately ignored: it's routine housekeeping already visible in the
 *    context panel's reclaimed line, and would otherwise fire a toast on nearly every turn.
 *  - `custom` + a valid memory.suggestion payload → a save-these-facts prompt. */
export function classifyContextNotice(item: UIItem): ContextNotice | null {
  if (item.kind === 'system') return item.level === 'warn' ? { kind: 'toast', text: item.text } : null;
  if (item.kind === 'custom') {
    const suggestion = memorySuggestionData(item);
    if (suggestion) return { kind: 'suggestion', scope: suggestion.scope, facts: suggestion.facts };
  }
  return null;
}
