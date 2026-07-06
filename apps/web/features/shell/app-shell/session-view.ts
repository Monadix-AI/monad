import type { UIItem, UIMessageItem } from '@monad/protocol';
import type { Dispatch, KeyboardEvent as ReactKeyboardEvent, SetStateAction } from 'react';
import type { SessionCommandMenuItem } from '@/features/routes/sessions/SessionRoute';

import {
  compactDividerItems,
  groupToolCalls,
  textFromParts,
  type ViewItem,
  viewItemFromUi,
  viewItemKey
} from '@/features/session/chat-view-items';

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
  if (transcriptMode === 'live') {
    const streamedUserText = new Set(
      visibleLiveItems
        .filter((item): item is UIMessageItem => item.kind === 'message' && item.role === 'user')
        .map((item) => textFromParts(item.parts))
    );
    const historyUserTexts = new Set(
      visibleHistory
        .filter((item): item is UIMessageItem => item.kind === 'message' && item.role === 'user')
        .map((item) => textFromParts(item.parts))
    );
    for (const message of optimistic) {
      if (items.has(`message:${message.id}`)) continue;
      if (
        'role' in message &&
        message.role === 'user' &&
        (streamedUserText.has(message.text) || historyUserTexts.has(message.text))
      ) {
        continue;
      }
      out.push(message);
    }
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
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveSkill((index) => (index + 1) % menuItems.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveSkill((index) => (index - 1 + menuItems.length) % menuItems.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
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
