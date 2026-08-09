import type { Translate } from '@monad/i18n';
import type {
  ChatMessage,
  Event,
  MeshSessionId,
  SessionUiEvent,
  UIItem,
  UIMessageItem,
  UIMessageOutlineItem
} from '@monad/protocol';
import type { ProjectionMutations } from './ui-projection-state.ts';

import { createI18n, DEFAULT_LOCALE } from '@monad/i18n';
import { isReplyableMessage } from '@monad/protocol';

import {
  agentDisplayNameFromData,
  agentNameFromData,
  deliveryIdFromData,
  displayFromToolResultData,
  isEvictable,
  isSilentChannelMessage,
  isUnknownToolResult,
  itemKey,
  meshSessionIdFromData,
  partsFromMessage,
  projectQaAnswerItem,
  projectQaQuestionMessageId,
  questionPresentationFromMessage,
  sourceFromData,
  statusFromMessage
} from './ui-projection-helpers.ts';
import { applyInteractionEvent } from './ui-projection-interaction-events.ts';
import { applyMessageEvent } from './ui-projection-message-events.ts';
import { applyToolEvent } from './ui-projection-tool-events.ts';

// Ceiling on live-streamed items a single held-open subscription's projector retains. Well above the
// hydration window (LIVE_SNAPSHOT_LIMIT); only a very long-lived viewer streaming thousands of turns
// hits it. Eviction drops the OLDEST already-settled items (the client keeps its own copy and the
// projector never re-emits a settled item), so it bounds memory without any client-visible effect.
const MAX_LIVE_UI_ITEMS = 1000;

// Builtin-English fallback for projectors constructed without a session translator (tests, legacy
// call sites) — keeps projected system copy flowing through the catalog instead of hardcoded strings.
let defaultT: Translate | undefined;
function fallbackT(): Translate {
  defaultT ??= createI18n({ locale: DEFAULT_LOCALE, packs: [] }).t;
  return defaultT;
}

interface MemorySummaryProjection {
  summary: string;
  uptoMessageId: string;
}

export class SessionUiProjector {
  private readonly items = new Map<string, UIItem>();
  private readonly order: string[] = [];
  private readonly rawStreamingText = new Map<string, string>();
  private readonly streamingDeltaIndex = new Map<string, number>();
  private readonly toolIntermediateMessageIds = new Set<string>();
  // Per-message channel-display parse cache: the raw length at the last parse + the text it yielded,
  // so intermediate tokens can reuse it instead of re-parsing the whole accumulated JSON each time.
  private readonly channelDisplayCache = new Map<string, { len: number; text: string }>();
  private lastCursor: string | undefined;
  // Oldest RAW message id hydrated — the `before` cursor a client uses to page older history.
  // (Not a UI-item id: projection is not 1:1, so the client cannot derive this from the items.)
  private oldestMessageId: string | undefined;
  // Live-eviction only applies after the initial snapshot is taken, so a bounded hydration window or a
  // Hydration snapshots are bounded by the caller; only unbounded live streaming on a held-open
  // subscription is trimmed here.
  private snapshotted = false;

  private readonly mutations: ProjectionMutations;

  constructor(private readonly opts: { channelStructured?: boolean; t?: Translate } = {}) {
    this.mutations = {
      opts: this.opts,
      t: this.opts.t ?? fallbackT(),
      items: this.items,
      rawStreamingText: this.rawStreamingText,
      streamingDeltaIndex: this.streamingDeltaIndex,
      channelDisplayCache: this.channelDisplayCache,
      toolIntermediateMessageIds: this.toolIntermediateMessageIds,
      upsert: (item) => this.upsert(item),
      remove: (kind, id) => this.remove(kind, id),
      setMessage: (item) => this.setMessage(item),
      setCustom: (args) => this.setCustom(args),
      findMessage: (id) => this.findMessage(id),
      nextMessageSeq: (candidate, messageId) => this.nextMessageSeq(candidate, messageId),
      messageObservationPointers: (payload, existing) => this.messageObservationPointers(payload, existing),
      clearItems: () => this.clearItems()
    };
  }

  private clearItems(): SessionUiEvent {
    this.items.clear();
    this.order.length = 0;
    this.toolIntermediateMessageIds.clear();
    return this.snapshot();
  }

  private upsert(item: UIItem): UIItem {
    const key = itemKey(item.kind, item.id);
    if (!this.items.has(key)) {
      this.order.push(key);
      if (this.snapshotted) this.evictOldestSettled();
    }
    this.items.set(key, item);
    return item;
  }

  // Bound a long-lived subscription's memory: when live items exceed the ceiling, drop the oldest
  // already-settled ones. Only runs post-snapshot and on genuine growth (new keys), so it's off the
  // per-token update path and never trims a hydration/lineage snapshot.
  private evictOldestSettled(): void {
    let overflow = this.order.length - MAX_LIVE_UI_ITEMS;
    if (overflow <= 0) return;
    for (let i = 0; i < this.order.length && overflow > 0; ) {
      const key = this.order[i];
      const item = key === undefined ? undefined : this.items.get(key);
      if (item && isEvictable(item)) {
        this.items.delete(key as string);
        this.order.splice(i, 1);
        overflow--;
      } else i++;
    }
  }

  private remove(kind: 'message' | 'approval' | 'clarification' | 'custom' | 'tool', id: string): SessionUiEvent {
    const key = itemKey(kind, id);
    this.items.delete(key);
    const idx = this.order.indexOf(key);
    if (idx >= 0) this.order.splice(idx, 1);
    return {
      kind: 'remove',
      ...(this.lastCursor ? { cursor: this.lastCursor as `evt_${string}` } : {}),
      target: { kind, id }
    };
  }

  private findMessage(id: string): UIMessageItem | undefined {
    const item = this.items.get(itemKey('message', id));
    return item?.kind === 'message' ? item : undefined;
  }

  private nextMessageSeq(candidate: string, messageId: string): string {
    const candidateMs = Date.parse(candidate);
    if (Number.isNaN(candidateMs)) return candidate;
    let latestMs = Number.NEGATIVE_INFINITY;
    for (const item of this.items.values()) {
      if (item.kind !== 'message' || item.id === messageId) continue;
      const itemMs = Date.parse(item.seq);
      if (!Number.isNaN(itemMs)) latestMs = Math.max(latestMs, itemMs);
    }
    return new Date(Math.max(candidateMs, latestMs + 1)).toISOString();
  }

  private messageObservationPointers(
    payload: { meshSessionId?: MeshSessionId; deliveryId?: `deliv_${string}` },
    existing?: UIMessageItem
  ): Pick<UIMessageItem, 'meshSessionId' | 'deliveryId'> {
    return {
      ...(payload.meshSessionId
        ? { meshSessionId: payload.meshSessionId }
        : existing?.meshSessionId
          ? { meshSessionId: existing.meshSessionId }
          : {}),
      ...(payload.deliveryId
        ? { deliveryId: payload.deliveryId }
        : existing?.deliveryId
          ? { deliveryId: existing.deliveryId }
          : {})
    };
  }

  private setMessage(item: UIMessageItem): SessionUiEvent {
    this.upsert(item);
    return { kind: 'upsert', ...(this.lastCursor ? { cursor: this.lastCursor as `evt_${string}` } : {}), item };
  }

  private setCustom(args: {
    id: string;
    name: string;
    data?: unknown;
    status?: 'streaming' | 'done' | 'error';
    seq: string;
  }): SessionUiEvent {
    const item: Extract<UIItem, { kind: 'custom' }> = {
      kind: 'custom',
      id: args.id,
      name: args.name,
      ...(args.data !== undefined ? { data: args.data } : {}),
      ...(args.status ? { status: args.status } : {}),
      seq: args.seq
    };
    return {
      kind: 'upsert',
      ...(this.lastCursor ? { cursor: this.lastCursor as `evt_${string}` } : {}),
      item: this.upsert(item)
    };
  }

  hydrateMessages(messages: ChatMessage[], memorySummary?: MemorySummaryProjection | null): void {
    this.oldestMessageId = messages[0]?.id;
    const orderedMessages = [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const toolIntermediateMessageIds = new Set(
      orderedMessages.flatMap((message, index) => {
        const next = orderedMessages[index + 1];
        return message.role === 'assistant' &&
          message.type === 'text' &&
          message.text.trim() === '' &&
          next?.type === 'tool_call'
          ? [message.id]
          : [];
      })
    );
    const tools = new Map<string, Extract<UIItem, { kind: 'tool' }>>();
    let summaryInserted = false;
    const insertSummary = () => {
      if (!memorySummary || summaryInserted) return;
      summaryInserted = true;
      this.upsert({
        kind: 'memory_summary',
        id: `memory-summary:${memorySummary.uptoMessageId}`,
        summary: memorySummary.summary,
        uptoMessageId: memorySummary.uptoMessageId,
        seq: memorySummary.uptoMessageId
      });
    };
    if (memorySummary && !messages.some((message) => message.id === memorySummary.uptoMessageId)) insertSummary();
    for (const message of orderedMessages) {
      if (toolIntermediateMessageIds.has(message.id)) {
        if (message.id === memorySummary?.uptoMessageId) insertSummary();
        continue;
      }
      if (message.type === 'tool_call') {
        const data = message.data as { toolCallId?: string; toolName?: string; input?: unknown } | undefined;
        const id = data?.toolCallId ?? message.id;
        const item: Extract<UIItem, { kind: 'tool' }> = {
          kind: 'tool',
          id,
          tool: data?.toolName ?? 'tool',
          ...(data?.input !== undefined ? { input: data.input } : {}),
          status: 'running',
          seq: message.createdAt
        };
        tools.set(id, item);
        this.upsert(item);
        if (message.id === memorySummary?.uptoMessageId) insertSummary();
        continue;
      }
      if (message.type === 'tool_result') {
        const data = message.data as
          | {
              toolCallId?: string;
              toolName?: string;
              output?: string;
              ok?: boolean;
              display?: unknown;
              result?: { displayContent?: unknown };
            }
          | undefined;
        const id = data?.toolCallId ?? message.id;
        const output = data?.output ?? message.text;
        const existing = tools.get(id);
        const tool = data?.toolName ?? existing?.tool;
        if (data?.ok === false && isUnknownToolResult(tool, output)) {
          tools.delete(id);
          const key = itemKey('tool', id);
          this.items.delete(key);
          const idx = this.order.indexOf(key);
          if (idx >= 0) this.order.splice(idx, 1);
          if (message.id === memorySummary?.uptoMessageId) insertSummary();
          continue;
        }
        const nextExisting = existing ?? {
          kind: 'tool',
          id,
          tool: tool ?? 'tool',
          status: 'running' as const,
          seq: message.createdAt
        };
        const next: Extract<UIItem, { kind: 'tool' }> = {
          ...nextExisting,
          ...(output ? { output } : {}),
          ...(data && displayFromToolResultData(data) !== undefined
            ? { display: displayFromToolResultData(data) }
            : {}),
          // Explicit ok field is preferred; fall back to legacy `Error:` prefix heuristic for older records.
          status: data?.ok === false ? 'error' : data?.ok === true ? 'ok' : output.startsWith('Error:') ? 'error' : 'ok'
        };
        tools.set(id, next);
        this.upsert(next);
        if (message.id === memorySummary?.uptoMessageId) insertSummary();
        continue;
      }
      const questionMessageId = projectQaQuestionMessageId(message);
      const projectQaAnswer = projectQaAnswerItem(
        message,
        questionMessageId ? this.findMessage(questionMessageId) : undefined
      );
      if (projectQaAnswer) {
        this.upsert(projectQaAnswer);
        continue;
      }
      if (message.role !== 'user' && message.role !== 'assistant') continue;
      if (isSilentChannelMessage(message, this.opts)) {
        if (message.id === memorySummary?.uptoMessageId) insertSummary();
        continue;
      }
      const question = questionPresentationFromMessage(message);
      const status = statusFromMessage(message);
      const source = sourceFromData(message.data);
      this.upsert({
        kind: 'message',
        id: message.id,
        role: message.role,
        ...(message.role === 'assistant' && agentNameFromData(message.data)
          ? { agentName: agentNameFromData(message.data) }
          : {}),
        ...(message.role === 'assistant' && agentDisplayNameFromData(message.data)
          ? { agentDisplayName: agentDisplayNameFromData(message.data) }
          : {}),
        ...(message.role === 'assistant' && source ? { source } : {}),
        ...(message.role === 'assistant' && meshSessionIdFromData(message.data)
          ? { meshSessionId: meshSessionIdFromData(message.data) }
          : {}),
        ...(message.role === 'assistant' && deliveryIdFromData(message.data)
          ? { deliveryId: deliveryIdFromData(message.data) }
          : {}),
        ...(message.metadata?.origin ? { origin: message.metadata.origin } : {}),
        parts: partsFromMessage(message, this.opts),
        ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
        replyable: isReplyableMessage(message),
        ...(question ? { question } : {}),
        status,
        seq:
          message.role === 'assistant' && source && (status === 'done' || status === 'error')
            ? (message.updatedAt ?? message.createdAt)
            : message.createdAt
      });
      if (message.id === memorySummary?.uptoMessageId) insertSummary();
    }
  }

  applyEvent(event: Event): SessionUiEvent[] {
    this.lastCursor = event.id;
    return (
      applyMessageEvent(this.mutations, event) ??
      applyToolEvent(this.mutations, event) ??
      applyInteractionEvent(this.mutations, event) ??
      []
    );
  }

  snapshot(
    opts: { hasMore?: boolean; messageOutline?: UIMessageOutlineItem[]; replacesTranscript?: boolean } = {}
  ): SessionUiEvent {
    // From here on the initial view is committed; subsequent live growth may be evicted (see upsert).
    this.snapshotted = true;
    return {
      kind: 'snapshot',
      ...(this.lastCursor ? { cursor: this.lastCursor as `evt_${string}` } : {}),
      ...(this.oldestMessageId ? { oldestCursor: this.oldestMessageId as `msg_${string}` } : {}),
      ...(opts.hasMore ? { hasMore: true } : {}),
      ...(opts.messageOutline ? { messageOutline: opts.messageOutline } : {}),
      ...(opts.replacesTranscript ? { replacesTranscript: true } : {}),
      items: this.order.map((key) => this.items.get(key)).filter((item): item is UIItem => item !== undefined)
    };
  }
}
