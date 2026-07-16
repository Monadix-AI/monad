import type { UIItem } from '@monad/protocol';
import type { Dispatch, KeyboardEvent as ReactKeyboardEvent, SetStateAction } from 'react';
import type { SessionCommandMenuItem } from '#/features/session/command-menu';

import {
  collapseAnsweredCommandMessages,
  compactDividerItems,
  groupToolCalls,
  messageTextFromParts,
  type ViewItem,
  viewItemFromUi,
  viewItemKey
} from '#/features/session/chat-view-items';

export const EMPTY_UI_ITEMS: UIItem[] = [];

const SEGMENT_COLORS: Record<string, string> = {
  customAgents: 'var(--success)',
  mcpTools: 'var(--info)',
  memory: 'var(--warning)',
  messages: 'var(--primary)',
  skills: 'var(--destructive)',
  systemPrompt: 'var(--accent-blue)',
  systemTools: 'var(--warning)'
};

type ComposerKeyDownEvent = KeyboardEvent | ReactKeyboardEvent<HTMLElement>;

type ContextUsage = Extract<UIItem, { kind: 'context' }>['usage'];

export function countServerUserMessagesByText(items: UIItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  for (const item of items) {
    if (item.kind !== 'message' || item.role !== 'user' || seen.has(item.id)) continue;
    seen.add(item.id);
    const text = messageTextFromParts(item.parts);
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return counts;
}

export function reconcileOptimisticMessages<T extends ViewItem>({
  legacyServerItems,
  optimistic,
  serverItems
}: {
  legacyServerItems?: UIItem[];
  optimistic: T[];
  serverItems: UIItem[];
}): T[] {
  const serverUserTextCounts = countServerUserMessagesByText(serverItems);
  const legacyUserTextCounts = countServerUserMessagesByText(legacyServerItems ?? serverItems);
  return optimistic.filter((message) => {
    if (!('role' in message) || message.role !== 'user') return true;
    if (message.serverEchoOrdinal !== undefined) {
      return (serverUserTextCounts.get(message.text) ?? 0) < message.serverEchoOrdinal;
    }
    const count = legacyUserTextCounts.get(message.text) ?? 0;
    if (count <= 0) return true;
    legacyUserTextCounts.set(message.text, count - 1);
    return false;
  });
}

export function buildSessionContextUsage(usage: ContextUsage | undefined) {
  if (!usage) return undefined;
  const segmentsByCategory = new Map<string, { category: string; label: string; tokens: number }>();
  for (const segment of usage.segments) {
    const existing = segmentsByCategory.get(segment.category);
    if (existing) existing.tokens += segment.tokens;
    else segmentsByCategory.set(segment.category, { ...segment });
  }
  return {
    approximate: usage.approximate,
    limit: usage.contextLimit,
    segments: Array.from(segmentsByCategory.values()).map((segment) => ({
      category: segment.category,
      color: SEGMENT_COLORS[segment.category],
      label: segment.label,
      tokens: segment.tokens
    })),
    used: usage.used
  };
}

export function buildViewMessages({
  commandPending,
  optimistic,
  transcriptMode,
  visibleHistory,
  visibleLiveItems
}: {
  commandPending: string | null;
  optimistic: ViewItem[];
  transcriptMode: 'history' | 'live';
  visibleHistory: UIItem[];
  visibleLiveItems: UIItem[];
}): ViewItem[] {
  const items = new Map<string, ViewItem>();
  const sources = transcriptMode === 'history' ? [visibleHistory] : [visibleHistory, visibleLiveItems];
  for (const source of sources) {
    for (const item of source) {
      const key = viewItemKey(item);
      const viewItem = viewItemFromUi(item);
      if (!key || !viewItem) continue;
      items.set(key, viewItem);
    }
  }
  const out = [...items.values()];
  const pendingOptimistic = reconcileOptimisticMessages({
    optimistic,
    serverItems: [...visibleHistory, ...visibleLiveItems]
  });
  for (const message of pendingOptimistic) {
    if (items.has(`message:${message.id}`)) continue;
    out.push(message);
  }
  return groupToolCalls(collapseAnsweredCommandMessages(compactDividerItems(out, commandPending)));
}

export function createTextareaKeyDownHandler({
  activeSkill,
  applyItem,
  followUpBehavior,
  handleForceSteer,
  handleQueueSubmit,
  isBusy,
  menuItems,
  setActiveSkill,
  setSkillMenuDismissed,
  skillMenuOpen
}: {
  activeSkill: number;
  applyItem: (item: SessionCommandMenuItem) => void;
  followUpBehavior: 'queue' | 'steer';
  handleForceSteer: () => Promise<unknown>;
  handleQueueSubmit: () => Promise<unknown>;
  isBusy: boolean;
  menuItems: SessionCommandMenuItem[];
  setActiveSkill: Dispatch<SetStateAction<number>>;
  setSkillMenuDismissed: Dispatch<SetStateAction<boolean>>;
  skillMenuOpen: boolean;
}) {
  return (event: ComposerKeyDownEvent) => {
    if (isComposingKeyEvent(event)) return;
    if (skillMenuOpen) {
      if (event.key === 'ArrowDown' && menuItems.length > 0) {
        event.preventDefault();
        setActiveSkill((index) => Math.min(index + 1, menuItems.length - 1));
        return;
      }
      if (event.key === 'ArrowUp' && menuItems.length > 0) {
        event.preventDefault();
        setActiveSkill((index) => Math.max(index - 1, 0));
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && menuItems.length > 0) {
        event.preventDefault();
        const picked = menuItems[Math.min(activeSkill, menuItems.length - 1)];
        if (picked) applyItem(picked);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setSkillMenuDismissed(true);
        return;
      }
    }
    const primaryModifier = primaryModifierPressed(event);
    if (isBusy && event.key === 'Enter' && primaryModifier && !event.shiftKey) {
      event.preventDefault();
      if (followUpBehavior === 'queue') void handleForceSteer();
      else void handleQueueSubmit();
      return;
    }
  };
}

function isComposingKeyEvent(event: ComposerKeyDownEvent): boolean {
  const nativeEvent = 'nativeEvent' in event ? event.nativeEvent : event;
  return Boolean(nativeEvent.isComposing || event.keyCode === 229);
}

function primaryModifierPressed(event: ComposerKeyDownEvent): boolean {
  if (typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform)) return event.metaKey;
  return event.ctrlKey;
}
