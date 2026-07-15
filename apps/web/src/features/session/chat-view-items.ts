import type { Msg } from './ChatMessage';
import type { ToolGroupItem, ToolItem, ToolViewItem } from './ToolStepView';

import {
  branchSourceSchema,
  channelDisplayText,
  type MessageId,
  type SessionId,
  type UIItem,
  type UIMessageItem,
  type UIPart
} from '@monad/protocol';

export type MemorySummaryViewItem = Extract<UIItem, { kind: 'memory_summary' }> & { kind: 'memory_summary' };

export interface CompactCommandViewItem {
  kind: 'compact_command';
  id: string;
  status: 'pending' | 'done' | 'noop';
  summary?: string;
}

export interface BranchSourceViewItem {
  id: string;
  kind: 'branch_source';
  messageId: MessageId;
  sessionId: SessionId;
}

export type ViewItem = Msg | ToolViewItem | MemorySummaryViewItem | CompactCommandViewItem | BranchSourceViewItem;

export const isToolItem = (m: ViewItem): m is ToolViewItem =>
  'kind' in m && (m.kind === 'tool' || m.kind === 'toolGroup');

export const isMemorySummaryItem = (m: ViewItem): m is MemorySummaryViewItem =>
  'kind' in m && m.kind === 'memory_summary';

export const isCompactCommandItem = (m: ViewItem): m is CompactCommandViewItem =>
  'kind' in m && m.kind === 'compact_command';

export const isBranchSourceItem = (m: ViewItem): m is BranchSourceViewItem => 'kind' in m && m.kind === 'branch_source';

export function branchSourceHref(source: Pick<BranchSourceViewItem, 'messageId' | 'sessionId'>): string {
  return `/sessions/${encodeURIComponent(source.sessionId)}?msg=${encodeURIComponent(source.messageId)}`;
}

export function branchSourceSessionName(
  source: Pick<BranchSourceViewItem, 'sessionId'>,
  ancestors?: ReadonlyArray<{ id: SessionId; title: string }>
): string {
  return ancestors?.find((session) => session.id === source.sessionId)?.title || source.sessionId;
}

function isDirectiveMessage(item: ViewItem, role: Msg['role']): item is Msg {
  return 'role' in item && item.role === role && item.type === 'directive';
}

export function collapseAnsweredCommandMessages(items: ViewItem[]): ViewItem[] {
  return items.filter((item, index) => {
    if (!('role' in item) || item.role !== 'user' || !item.text.trimStart().startsWith('/')) return true;
    const reply = items[index + 1];
    return !reply || !isDirectiveMessage(reply, 'assistant');
  });
}

function compactEffectFromMessage(item: ViewItem): { compacted: number; summary?: string } | null {
  if (!('role' in item) || item.role !== 'assistant') return null;
  const effect = (item.data as { effect?: { type?: string; compacted?: unknown; summary?: unknown } } | undefined)
    ?.effect;
  if (effect?.type !== 'compacted' || typeof effect.compacted !== 'number') return null;
  return {
    compacted: effect.compacted,
    ...(typeof effect.summary === 'string' ? { summary: effect.summary } : {})
  };
}

function isCompactUserMessage(item: ViewItem): item is Msg {
  return 'role' in item && item.role === 'user' && item.text.trim() === '/compact';
}

export function compactDividerItems(items: ViewItem[], commandPending: string | null): ViewItem[] {
  const hasCompactCommand = items.some(isCompactUserMessage);
  const out: ViewItem[] = [];
  let latestSummary: string | undefined;
  let unresolvedCompactIndex: number | null = null;
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as ViewItem;
    if (isMemorySummaryItem(item)) {
      latestSummary = item.summary;
      if (hasCompactCommand) continue;
      out.push(item);
      continue;
    }
    const effect = compactEffectFromMessage(item);
    if (effect) {
      if (unresolvedCompactIndex !== null) {
        const compactItem = out[unresolvedCompactIndex];
        if (isCompactCommandItem(compactItem)) {
          out[unresolvedCompactIndex] = {
            ...compactItem,
            status: effect.compacted > 0 ? 'done' : 'noop',
            ...((effect.summary ?? latestSummary) ? { summary: effect.summary ?? latestSummary } : {})
          };
        }
        unresolvedCompactIndex = null;
      }
      continue;
    }
    if (!isCompactUserMessage(item)) {
      out.push(item);
      continue;
    }
    unresolvedCompactIndex = out.length;
    out.push({
      kind: 'compact_command',
      id: item.id,
      status: 'done'
    });
  }
  if (commandPending === 'compact' && unresolvedCompactIndex !== null) {
    const compactItem = out[unresolvedCompactIndex];
    if (isCompactCommandItem(compactItem)) {
      out[unresolvedCompactIndex] = { ...compactItem, status: 'pending' };
    }
  }
  return out;
}

function textFromParts(parts: UIPart[]): string {
  return parts
    .filter((part): part is Extract<UIPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

export function messageTextFromParts(parts: UIPart[]): string {
  return textFromParts(parts) || artifactFromParts(parts)?.text || '';
}

function reasoningFromParts(parts: UIPart[]): string | undefined {
  const text = parts
    .filter((part): part is Extract<UIPart, { type: 'reasoning' }> => part.type === 'reasoning')
    .map((part) => part.text)
    .join('');
  return text || undefined;
}

function artifactFromParts(parts: UIPart[]): Extract<UIPart, { type: 'artifact' }> | undefined {
  return parts.find((part): part is Extract<UIPart, { type: 'artifact' }> => part.type === 'artifact');
}

function messageFromUi(item: UIMessageItem): Msg {
  const artifact = artifactFromParts(item.parts);
  const text = messageTextFromParts(item.parts);
  return {
    id: item.id,
    role: item.role,
    text: item.role === 'assistant' ? channelDisplayText(text) : text,
    reasoning: reasoningFromParts(item.parts),
    error: item.status === 'error',
    streaming: item.status === 'streaming',
    type: artifact?.messageType,
    data: artifact?.data
  };
}

function toolFromUi(item: Extract<UIItem, { kind: 'tool' }>): ToolItem {
  return {
    kind: 'tool',
    id: item.id,
    tool: item.tool,
    input: item.input,
    status: item.status,
    output: item.output
  };
}

export function viewItemKey(item: UIItem): string | null {
  if (item.kind !== 'message' && item.kind !== 'tool' && item.kind !== 'memory_summary') return null;
  return `${item.kind}:${item.id}`;
}

export function viewItemFromUi(item: UIItem): ViewItem | null {
  if (item.kind === 'message') {
    const sourcePart = item.parts.find(
      (part): part is Extract<UIPart, { type: 'artifact' }> =>
        part.type === 'artifact' && part.messageType === 'branch_source'
    );
    if (sourcePart) {
      const source = branchSourceSchema.safeParse(sourcePart.data);
      if (source.success) return { id: item.id, kind: 'branch_source', ...source.data };
    }
    return messageFromUi(item);
  }
  if (item.kind === 'tool') return toolFromUi(item);
  if (item.kind === 'memory_summary') return item;
  return null;
}

export function groupToolCalls(items: ViewItem[]): ViewItem[] {
  const out: ViewItem[] = [];
  let pending: ToolItem[] = [];
  const flush = () => {
    if (pending.length === 1) out.push(pending[0] as ToolItem);
    else if (pending.length > 1) {
      out.push({
        kind: 'toolGroup',
        id: `tool-group:${pending.map((step) => step.id).join(':')}`,
        steps: pending
      } satisfies ToolGroupItem);
    }
    pending = [];
  };

  for (const item of items) {
    if ('kind' in item && item.kind === 'tool') {
      pending.push(item);
      continue;
    }
    flush();
    out.push(item);
  }
  flush();
  return out;
}
