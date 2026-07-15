import type {
  ChatMessage,
  Event,
  ExternalAgentSessionId,
  SessionUiEvent,
  UIItem,
  UIMessageItem
} from '@monad/protocol';
import type { ExternalAgentSessionSnapshot } from './ui-projection-helpers.ts';
import type { ProjectionMutations } from './ui-projection-state.ts';

import {
  agentNameFromData,
  deliveryIdFromData,
  displayFromToolResultData,
  externalAgentSessionIdFromData,
  externalAgentToolItem,
  isEvictable,
  isSilentChannelMessage,
  isUnknownToolResult,
  itemKey,
  partsFromMessage,
  sourceFromData,
  statusFromMessage
} from './ui-projection-helpers.ts';
import { applyInteractionEvent } from './ui-projection-interaction-events.ts';
import { applyMessageEvent } from './ui-projection-message-events.ts';
import { applyToolEvent } from './ui-projection-tool-events.ts';

export type { ExternalAgentSessionSnapshot } from './ui-projection-helpers.ts';

// Ceiling on live-streamed items a single held-open subscription's projector retains. Well above the
// hydration window (LIVE_SNAPSHOT_LIMIT); only a very long-lived viewer streaming thousands of turns
// hits it. Eviction drops the OLDEST already-settled items (the client keeps its own copy and the
// projector never re-emits a settled item), so it bounds memory without any client-visible effect.
const MAX_LIVE_UI_ITEMS = 1000;

interface MemorySummaryProjection {
  summary: string;
  uptoMessageId: string;
}

export class SessionUiProjector {
  private readonly items = new Map<string, UIItem>();
  private readonly order: string[] = [];
  private readonly rawStreamingText = new Map<string, string>();
  // Per-message channel-display parse cache: the raw length at the last parse + the text it yielded,
  // so intermediate tokens can reuse it instead of re-parsing the whole accumulated JSON each time.
  private readonly channelDisplayCache = new Map<string, { len: number; text: string }>();
  private lastCursor: string | undefined;
  // Oldest RAW message id hydrated — the `before` cursor a client uses to page older history.
  // (Not a UI-item id: projection is not 1:1, so the client cannot derive this from the items.)
  private oldestMessageId: string | undefined;
  // Live-eviction only applies after the initial snapshot is taken, so a bounded hydration window or a
  // full includeAncestors snapshot is never trimmed — only unbounded live streaming on a held-open
  // subscription is.
  private snapshotted = false;

  private readonly mutations: ProjectionMutations;

  constructor(private readonly opts: { channelStructured?: boolean } = {}) {
    this.mutations = {
      opts: this.opts,
      items: this.items,
      rawStreamingText: this.rawStreamingText,
      channelDisplayCache: this.channelDisplayCache,
      upsert: (item) => this.upsert(item),
      remove: (kind, id) => this.remove(kind, id),
      setMessage: (item) => this.setMessage(item),
      setCustom: (args) => this.setCustom(args),
      findMessage: (id) => this.findMessage(id),
      messageObservationPointers: (payload, existing) => this.messageObservationPointers(payload, existing),
      clearItems: () => this.clearItems()
    };
  }

  private clearItems(): SessionUiEvent {
    this.items.clear();
    this.order.length = 0;
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

  private messageObservationPointers(
    payload: { externalAgentSessionId?: ExternalAgentSessionId; deliveryId?: `deliv_${string}` },
    existing?: UIMessageItem
  ): Pick<UIMessageItem, 'externalAgentSessionId' | 'deliveryId'> {
    return {
      ...(payload.externalAgentSessionId
        ? { externalAgentSessionId: payload.externalAgentSessionId }
        : existing?.externalAgentSessionId
          ? { externalAgentSessionId: existing.externalAgentSessionId }
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
    seq?: string;
  }): SessionUiEvent {
    const item: Extract<UIItem, { kind: 'custom' }> = {
      kind: 'custom',
      id: args.id,
      name: args.name,
      ...(args.data !== undefined ? { data: args.data } : {}),
      ...(args.status ? { status: args.status } : {}),
      seq: args.seq ?? this.lastCursor ?? args.id
    };
    return {
      kind: 'upsert',
      ...(this.lastCursor ? { cursor: this.lastCursor as `evt_${string}` } : {}),
      item: this.upsert(item)
    };
  }

  hydrateMessages(messages: ChatMessage[], memorySummary?: MemorySummaryProjection | null): void {
    this.oldestMessageId = messages[0]?.id;
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
    for (const message of messages) {
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
      if (message.role !== 'user' && message.role !== 'assistant') continue;
      if (isSilentChannelMessage(message, this.opts)) {
        if (message.id === memorySummary?.uptoMessageId) insertSummary();
        continue;
      }
      this.upsert({
        kind: 'message',
        id: message.id,
        role: message.role,
        ...(message.role === 'assistant' && agentNameFromData(message.data)
          ? { agentName: agentNameFromData(message.data) }
          : {}),
        ...(message.role === 'assistant' && sourceFromData(message.data)
          ? { source: sourceFromData(message.data) }
          : {}),
        ...(message.role === 'assistant' && externalAgentSessionIdFromData(message.data)
          ? { externalAgentSessionId: externalAgentSessionIdFromData(message.data) }
          : {}),
        ...(message.role === 'assistant' && deliveryIdFromData(message.data)
          ? { deliveryId: deliveryIdFromData(message.data) }
          : {}),
        parts: partsFromMessage(message, this.opts),
        status: statusFromMessage(message),
        seq: message.createdAt
      });
      if (message.id === memorySummary?.uptoMessageId) insertSummary();
    }
  }

  /**
   * Rebuild external agent tool cards from their durable output snapshots. Call after {@link hydrateMessages}
   * so a page refresh / reconnect shows a session's terminal output without replaying the (non-durable)
   * per-chunk `external_agent.output` events. Each card is inserted at its `startedAt` position so it
   * interleaves with messages in array-order clients; seq-sorting clients order it the same way.
   */
  hydrateExternalAgentSessions(sessions: ExternalAgentSessionSnapshot[]): void {
    for (const session of sessions) {
      const item = externalAgentToolItem(session);
      const key = itemKey('tool', item.id);
      if (this.items.has(key)) {
        this.items.set(key, item);
        continue;
      }
      this.items.set(key, item);
      this.insertOrdered(key, item.seq);
    }
  }

  /** Insert `key` into the display order at the first position whose item sorts after `seq`
   *  (memory-summary markers are skipped — their seq is a message id, not a timestamp). */
  private insertOrdered(key: string, seq: string): void {
    const pos = this.order.findIndex((k) => {
      const item = this.items.get(k);
      return item !== undefined && item.kind !== 'memory_summary' && item.seq > seq;
    });
    if (pos === -1) this.order.push(key);
    else this.order.splice(pos, 0, key);
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

  snapshot(opts: { hasMore?: boolean; replacesTranscript?: boolean } = {}): SessionUiEvent {
    // From here on the initial view is committed; subsequent live growth may be evicted (see upsert).
    this.snapshotted = true;
    return {
      kind: 'snapshot',
      ...(this.lastCursor ? { cursor: this.lastCursor as `evt_${string}` } : {}),
      ...(this.oldestMessageId ? { oldestCursor: this.oldestMessageId as `msg_${string}` } : {}),
      ...(opts.hasMore ? { hasMore: true } : {}),
      ...(opts.replacesTranscript ? { replacesTranscript: true } : {}),
      items: this.order.map((key) => this.items.get(key)).filter((item): item is UIItem => item !== undefined)
    };
  }
}
