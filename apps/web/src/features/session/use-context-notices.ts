import type { UIItem } from '@monad/protocol';

import { useAddMemoryFactMutation } from '@monad/client-rtk';
import { useEffect, useRef } from 'react';

import { useT } from '#/components/I18nProvider';
import { toast } from '#/components/ToastProvider';
import { classifyContextNotice } from './context-notice';

/** Surfaces the transient handoff nudge and the persisted memory.suggestion event (classified by
 *  classifyContextNotice) as toasts — a plain notice for the nudge, and a "remember these N things?"
 *  prompt with a Save action for the suggestion. Each id fires once. */
export function useContextNotices(items: readonly UIItem[]): void {
  const t = useT();
  const [addMemoryFact] = useAddMemoryFactMutation();
  const seen = useRef(new Set<string>());

  useEffect(() => {
    for (const item of items) {
      const notice = classifyContextNotice(item);
      if (!notice || seen.current.has(item.id)) continue;
      seen.current.add(item.id);
      if (notice.kind === 'toast') {
        toast.info(notice.text);
        continue;
      }
      const { scope, facts } = notice;
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
  }, [items, t, addMemoryFact]);
}
