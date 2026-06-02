import type { UIItem } from '@monad/protocol';
import type { Dispatch, KeyboardEvent as ReactKeyboardEvent, SetStateAction } from 'react';
import type { SessionCommandMenuItem } from '#/features/session/command-menu';

import {
  collapseAnsweredCommandMessages,
  compactDividerItems,
  groupToolCalls,
  isTransientAttentionUiItem,
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

function attachmentFingerprint(attachment: { bytes: number; mime: string; name: string }): string {
  return `${attachment.name}\u0000${attachment.mime}\u0000${attachment.bytes}`;
}

function withLocalAttachmentPreviews(viewItem: ViewItem, optimistic: ViewItem[]): ViewItem {
  if (!('role' in viewItem) || viewItem.role !== 'user' || !viewItem.attachments?.length) return viewItem;
  const serverAttachments = new Set(viewItem.attachments.map(attachmentFingerprint));
  const local = optimistic.find(
    (item) =>
      'role' in item &&
      item.role === 'user' &&
      item.text === viewItem.text &&
      item.attachments?.some(
        (attachment) => attachment.imageSrc && serverAttachments.has(attachmentFingerprint(attachment))
      )
  );
  if (!local || !('attachments' in local) || !local.attachments) return viewItem;
  const previews = new Map(
    local.attachments.flatMap((attachment) =>
      attachment.imageSrc ? [[attachmentFingerprint(attachment), attachment.imageSrc] as const] : []
    )
  );
  const attachments = viewItem.attachments.map((attachment) => {
    const imageSrc = previews.get(attachmentFingerprint(attachment));
    return imageSrc ? { ...attachment, imageSrc } : attachment;
  });
  return attachments.some((attachment, index) => attachment !== viewItem.attachments?.[index])
    ? { ...viewItem, attachments }
    : viewItem;
}

export function countServerUserMessagesByText(items: UIItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  for (const item of items) {
    if (item.kind !== 'message' || item.role !== 'user' || seen.has(item.id)) continue;
    seen.add(item.id);
    const text = messageTextFromParts(item.parts);
    const signature = item.replyToMessageId ? `${text}\u0000${item.replyToMessageId}` : text;
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
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
  const serverHasAssistant = serverItems.some((item) => item.kind === 'message' && item.role === 'assistant');
  return optimistic.filter((message) => {
    if (!('role' in message)) return true;
    if (message.role === 'assistant') {
      return !(serverHasAssistant && message.pending && message.id.startsWith('local-home-'));
    }
    if (message.role !== 'user') return true;
    const signature = message.replyToMessageId ? `${message.text}\u0000${message.replyToMessageId}` : message.text;
    if (message.serverEchoOrdinal !== undefined) {
      return (serverUserTextCounts.get(signature) ?? 0) < message.serverEchoOrdinal;
    }
    const count = legacyUserTextCounts.get(signature) ?? 0;
    if (count <= 0) return true;
    legacyUserTextCounts.set(signature, count - 1);
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
    reclaimed: usage.reclaimed,
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
  const sources =
    transcriptMode === 'history'
      ? [visibleHistory, visibleLiveItems.filter(isTransientAttentionUiItem)]
      : [visibleHistory, visibleLiveItems];
  for (const source of sources) {
    for (const item of source) {
      const key = viewItemKey(item);
      const projected = viewItemFromUi(item);
      const viewItem = projected ? withLocalAttachmentPreviews(projected, optimistic) : null;
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
