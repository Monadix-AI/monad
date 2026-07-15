import type { MemoryScopeQuery, UIItem } from '@monad/protocol';

import { useAddMemoryFactMutation } from '@monad/client-rtk';
import { useEffect, useRef } from 'react';

import { useT } from '#/components/I18nProvider';
import { toast } from '#/components/ToastProvider';

interface MemorySuggestionData {
  scope: { kind: MemoryScopeQuery['scopeKind']; id: MemoryScopeQuery['scopeId'] };
  facts: string[];
}

function isMemorySuggestion(
  item: Extract<UIItem, { kind: 'custom' }>
): item is Extract<UIItem, { kind: 'custom' }> & { data: MemorySuggestionData } {
  if (item.name !== 'memory.suggestion') return false;
  const data = item.data as Partial<MemorySuggestionData> | undefined;
  return Boolean(data?.scope && Array.isArray(data.facts) && data.facts.length > 0);
}

/** Turns two transient session events into ephemeral toasts, and the persisted memory.suggestion
 *  event into a "save these facts?" prompt — both projected server-side as UIItems (system / custom,
 *  see ui-projection-interaction-events.ts) that never render inline in the transcript
 *  (viewItemFromUi returns null for both kinds), so this is the only place they're surfaced. */
export function useContextNotices(items: readonly UIItem[]): void {
  const t = useT();
  const [addMemoryFact] = useAddMemoryFactMutation();
  const seenSystem = useRef(new Set<string>());
  const seenSuggestion = useRef(new Set<string>());

  useEffect(() => {
    for (const item of items) {
      if (item.kind === 'system') {
        if (seenSystem.current.has(item.id)) continue;
        seenSystem.current.add(item.id);
        // Only 'warn' (e.g. context.handoff_suggested) surfaces as a toast — routine housekeeping
        // like context.evicted is already passively visible via the context panel's reclaimed line
        // and would otherwise fire a toast on nearly every turn once the window fills up.
        if (item.level === 'warn') toast.info(item.text);
        continue;
      }
      if (item.kind === 'custom' && isMemorySuggestion(item)) {
        if (seenSuggestion.current.has(item.id)) continue;
        seenSuggestion.current.add(item.id);
        const { scope, facts } = item.data;
        toast.info(t('web.chat.memorySuggestion', { count: facts.length }), {
          duration: Number.POSITIVE_INFINITY,
          detail: facts,
          action: {
            label: t('web.chat.memorySuggestionSave'),
            onClick: async () => {
              await Promise.all(
                facts.map((content) => addMemoryFact({ scopeKind: scope.kind, scopeId: scope.id, content }))
              );
              return true;
            }
          }
        });
      }
    }
  }, [items, t, addMemoryFact]);
}
