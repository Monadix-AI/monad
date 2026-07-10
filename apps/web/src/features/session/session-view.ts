import type { UIItem } from '@monad/protocol';
import type { Dispatch, KeyboardEvent as ReactKeyboardEvent, SetStateAction } from 'react';
import type { SessionCommandMenuItem } from '#/features/session/command-menu';

import {
  compactDividerItems,
  groupToolCalls,
  textFromParts,
  type ViewItem,
  viewItemFromUi,
  viewItemKey
} from '#/features/session/chat-view-items';

export const EMPTY_UI_ITEMS: UIItem[] = [];

export const viewMessageId = (item: ViewItem): string => item.id;

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
  const serverUserTextCounts = new Map<string, number>();
  for (const item of [...visibleHistory, ...visibleLiveItems]) {
    if (item.kind !== 'message' || item.role !== 'user') continue;
    const text = textFromParts(item.parts);
    serverUserTextCounts.set(text, (serverUserTextCounts.get(text) ?? 0) + 1);
  }
  for (const message of optimistic) {
    if (items.has(`message:${message.id}`)) continue;
    if ('role' in message && message.role === 'user') {
      const count = serverUserTextCounts.get(message.text) ?? 0;
      if (count > 0) {
        serverUserTextCounts.set(message.text, count - 1);
        continue;
      }
    }
    out.push(message);
  }
  return groupToolCalls(compactDividerItems(out, commandPending));
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
