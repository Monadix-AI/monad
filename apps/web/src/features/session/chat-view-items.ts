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

export interface CompactTranscriptTurnViewItem {
  kind: 'compact_transcript_turn';
  id: string;
  status: 'running' | 'done';
  durationLabel: string;
  summary?: string;
  details: ViewItem[];
}

export type ViewItem =
  | Msg
  | ToolViewItem
  | MemorySummaryViewItem
  | CompactCommandViewItem
  | BranchSourceViewItem
  | CompactTranscriptTurnViewItem;

export const isToolItem = (m: ViewItem): m is ToolViewItem =>
  'kind' in m && (m.kind === 'tool' || m.kind === 'toolGroup');

export const isMemorySummaryItem = (m: ViewItem): m is MemorySummaryViewItem =>
  'kind' in m && m.kind === 'memory_summary';

export const isCompactCommandItem = (m: ViewItem): m is CompactCommandViewItem =>
  'kind' in m && m.kind === 'compact_command';

export const isBranchSourceItem = (m: ViewItem): m is BranchSourceViewItem => 'kind' in m && m.kind === 'branch_source';

export const isCompactTranscriptTurnItem = (m: ViewItem): m is CompactTranscriptTurnViewItem =>
  'kind' in m && m.kind === 'compact_transcript_turn';

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
    seq: item.seq,
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
    output: item.output,
    seq: item.seq
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
        steps: pending,
        seq: pending[0]?.seq
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

export function compactTranscriptTurns(items: ViewItem[]): ViewItem[] {
  const turns: ViewItem[] = [];
  let current: ViewItem[] = [];
  const flush = () => {
    if (current.length === 0) return;
    const first = current[0] as ViewItem | undefined;
    const last = current[current.length - 1] as ViewItem | undefined;
    const running = current.some(itemIsRunning);
    const summary = [...current].reverse().find(itemIsAssistantMessage)?.text;
    turns.push({
      kind: 'compact_transcript_turn',
      id: `compact-turn:${first?.id ?? turns.length}`,
      status: running ? 'running' : 'done',
      durationLabel: formatDuration(durationMs(firstSeq(current), itemSeq(last) ?? firstSeq(current))),
      ...(summary ? { summary } : {}),
      details: current
    });
    current = [];
  };

  for (const item of items) {
    if (itemIsUserMessage(item) && current.length > 0) flush();
    current.push(item);
  }
  flush();
  return turns;
}

function itemIsUserMessage(item: ViewItem): item is Msg {
  return 'role' in item && item.role === 'user';
}

function itemIsAssistantMessage(item: ViewItem): item is Msg {
  return (
    'role' in item &&
    item.role === 'assistant' &&
    item.streaming !== true &&
    item.pending !== true &&
    Boolean(item.text.trim())
  );
}

function itemIsRunning(item: ViewItem): boolean {
  if ('role' in item) return item.streaming === true || item.pending === true;
  if ('kind' in item && item.kind === 'tool') return item.status === 'running';
  if ('kind' in item && item.kind === 'toolGroup') return item.steps.some((step) => step.status === 'running');
  return false;
}

function itemSeq(item: ViewItem | undefined): string | undefined {
  if (!item) return undefined;
  if ('seq' in item && typeof item.seq === 'string') return item.seq;
  if ('kind' in item && item.kind === 'toolGroup') return item.steps.at(-1)?.seq ?? item.seq;
  return undefined;
}

function firstSeq(items: ViewItem[]): string | undefined {
  for (const item of items) {
    const seq = itemSeq(item);
    if (seq) return seq;
  }
  return undefined;
}

function durationMs(start: string | undefined, end: string | undefined): number {
  const startMs = timestampMs(start);
  const endMs = timestampMs(end);
  if (startMs === undefined || endMs === undefined) return 0;
  return Math.max(0, endMs - startMs);
}

function timestampMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function formatDuration(duration: number): string {
  const totalSeconds = Math.max(0, Math.floor(duration / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${minutes.toString().padStart(2, '0')}m${seconds.toString().padStart(2, '0')}s`;
  if (minutes > 0) return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
  return `${seconds}s`;
}
