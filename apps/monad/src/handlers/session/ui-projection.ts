import type { ChatMessage, Event, SessionUiEvent, UIItem, UIMessageItem, UIPart } from '@monad/protocol';
import type { NativeCliSessionSnapshot } from './ui-projection-helpers.ts';

import { channelDisplayText, channelStructuredVisibility, parseEventPayload } from '@monad/protocol';

import { findNativeCliProviderAdapter } from '@/services/native-cli/index.ts';
import {
  agentNameFromData,
  appendBoundedText,
  CHANNEL_REPARSE_MIN_DELTA,
  channelPartialDisplayText,
  deliveryIdFromData,
  displayFromToolResultData,
  isEvictable,
  isSilentChannelMessage,
  isUnknownToolResult,
  itemKey,
  MAX_NATIVE_CLI_UI_OUTPUT,
  nativeCliSessionIdFromData,
  nativeCliToolItem,
  partsFromMessage,
  sourceFromData,
  statusFromMessage
} from './ui-projection-helpers.ts';

export type { NativeCliSessionSnapshot } from './ui-projection-helpers.ts';

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

  constructor(private readonly opts: { channelStructured?: boolean } = {}) {}

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
    payload: { nativeCliSessionId?: string; deliveryId?: `deliv_${string}` },
    existing?: UIMessageItem
  ): Pick<UIMessageItem, 'nativeCliSessionId' | 'deliveryId'> {
    return {
      ...(payload.nativeCliSessionId
        ? { nativeCliSessionId: payload.nativeCliSessionId }
        : existing?.nativeCliSessionId
          ? { nativeCliSessionId: existing.nativeCliSessionId }
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
        ...(message.role === 'assistant' && nativeCliSessionIdFromData(message.data)
          ? { nativeCliSessionId: nativeCliSessionIdFromData(message.data) }
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
   * Rebuild native CLI tool cards from their durable output snapshots. Call after {@link hydrateMessages}
   * so a page refresh / reconnect shows a session's terminal output without replaying the (non-durable)
   * per-chunk `native_cli.output` events. Each card is inserted at its `startedAt` position so it
   * interleaves with messages in array-order clients; seq-sorting clients order it the same way.
   */
  hydrateNativeCliSessions(sessions: NativeCliSessionSnapshot[]): void {
    for (const session of sessions) {
      const item = nativeCliToolItem(session);
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
    switch (event.type) {
      case 'user.message': {
        const p = parseEventPayload('user.message', event.payload);
        return [
          this.setMessage({
            kind: 'message',
            id: p.messageId,
            role: 'user',
            parts: [{ type: 'text', text: p.text }],
            status: 'done',
            seq: event.at
          })
        ];
      }
      case 'agent.token': {
        const p = parseEventPayload('agent.token', event.payload);
        const existing = this.findMessage(p.messageId);
        const text = existing?.parts.find((part) => part.type === 'text');
        const parts = existing ? existing.parts.slice() : [];
        // Accumulate the full streamed text for every session, not just channel-structured ones: each
        // `agent.token` carries only its own delta, so the running text is reassembled here. The
        // existing text part holds *display* text (for a channel session, a filtered projection of the
        // raw JSON) and can't be appended to directly. Cleared on agent.message / agent.error.
        const rawText = `${this.rawStreamingText.get(p.messageId) ?? ''}${p.delta}`;
        this.rawStreamingText.set(p.messageId, rawText);
        let visibleText: string;
        if (this.opts.channelStructured) {
          const cached = this.channelDisplayCache.get(p.messageId);
          if (cached && rawText.length - cached.len < CHANNEL_REPARSE_MIN_DELTA && !p.delta.includes('}')) {
            visibleText = cached.text;
          } else {
            visibleText = channelPartialDisplayText(rawText);
            this.channelDisplayCache.set(p.messageId, { len: rawText.length, text: visibleText });
          }
        } else {
          visibleText = rawText;
        }
        if (text?.type === 'text') text.text = visibleText;
        else parts.push({ type: 'text', text: visibleText });
        return [
          this.setMessage({
            kind: 'message',
            id: p.messageId,
            role: 'assistant',
            ...(p.agentName
              ? { agentName: p.agentName }
              : existing?.agentName
                ? { agentName: existing.agentName }
                : {}),
            ...(p.source ? { source: p.source } : existing?.source ? { source: existing.source } : {}),
            ...this.messageObservationPointers(p, existing),
            parts,
            status: 'streaming',
            seq: existing?.seq ?? event.at
          })
        ];
      }
      case 'agent.reasoning': {
        const p = parseEventPayload('agent.reasoning', event.payload);
        const existing = this.findMessage(p.messageId);
        const reasoning = existing?.parts.find((part) => part.type === 'reasoning');
        const parts = existing ? existing.parts.slice() : [];
        if (reasoning?.type === 'reasoning') reasoning.text += p.delta;
        else parts.unshift({ type: 'reasoning', text: p.delta });
        return [
          this.setMessage({
            kind: 'message',
            id: p.messageId,
            role: 'assistant',
            ...(existing?.agentName ? { agentName: existing.agentName } : {}),
            ...(p.source ? { source: p.source } : existing?.source ? { source: existing.source } : {}),
            ...this.messageObservationPointers(p, existing),
            parts,
            status: 'streaming',
            seq: existing?.seq ?? event.at
          })
        ];
      }
      case 'agent.message': {
        const p = parseEventPayload('agent.message', event.payload);
        const existing = this.findMessage(p.messageId);
        this.rawStreamingText.delete(p.messageId);
        this.channelDisplayCache.delete(p.messageId);
        if (this.opts.channelStructured && channelStructuredVisibility(p.text) === 'silent') {
          return existing ? [this.remove('message', p.messageId)] : [];
        }
        const parts: UIPart[] = existing?.parts.filter((part) => part.type !== 'text') ?? [];
        const text = this.opts.channelStructured ? channelDisplayText(p.text) : p.text;
        parts.push(
          p.data !== undefined
            ? { type: 'artifact', messageType: 'directive', text, data: p.data }
            : { type: 'text', text }
        );
        if (p.attachments?.length && !parts.some((part) => part.type === 'custom' && part.name === 'attachment')) {
          for (const attachment of p.attachments) parts.push({ type: 'custom', name: 'attachment', data: attachment });
        }
        return [
          this.setMessage({
            kind: 'message',
            id: p.messageId,
            role: 'assistant',
            ...(p.agentName
              ? { agentName: p.agentName }
              : existing?.agentName
                ? { agentName: existing.agentName }
                : {}),
            ...(p.source ? { source: p.source } : existing?.source ? { source: existing.source } : {}),
            ...this.messageObservationPointers(p, existing),
            parts,
            status: 'done',
            seq: p.source === 'managed-native-cli' ? event.at : (existing?.seq ?? event.at)
          })
        ];
      }
      case 'agent.error': {
        const p = parseEventPayload('agent.error', event.payload);
        const id = p.messageId ?? `err-${event.id}`;
        if (p.messageId) {
          this.rawStreamingText.delete(p.messageId);
          this.channelDisplayCache.delete(p.messageId);
        }
        return [
          this.setMessage({
            kind: 'message',
            id,
            role: 'assistant',
            parts: [{ type: 'text', text: p.code ? `[${p.code}] ${p.message}` : p.message }],
            status: 'error',
            seq: (p.messageId ? this.findMessage(p.messageId)?.seq : undefined) ?? event.at
          })
        ];
      }
      case 'tool.called': {
        const p = parseEventPayload('tool.called', event.payload);
        return [
          {
            kind: 'upsert',
            cursor: event.id,
            item: this.upsert({
              kind: 'tool',
              id: p.toolCallId,
              tool: p.tool,
              ...(p.input !== undefined ? { input: p.input } : {}),
              status: 'running',
              seq: event.id
            })
          }
        ];
      }
      case 'tool.result': {
        const p = parseEventPayload('tool.result', event.payload);
        if (!p.ok && isUnknownToolResult(p.tool, p.result)) return [this.remove('tool', p.toolCallId)];
        const existing = this.items.get(itemKey('tool', p.toolCallId));
        const next: Extract<UIItem, { kind: 'tool' }> = {
          kind: 'tool',
          id: p.toolCallId,
          tool: existing?.kind === 'tool' ? existing.tool : 'tool',
          ...(existing?.kind === 'tool' && existing.input !== undefined ? { input: existing.input } : {}),
          ...((p.displayResult ?? p.result) ? { output: p.displayResult ?? p.result } : {}),
          ...('display' in p ? { display: p.display } : {}),
          status: p.ok ? 'ok' : 'error',
          seq: existing?.kind === 'tool' ? existing.seq : event.id
        };
        return [{ kind: 'upsert', cursor: event.id, item: this.upsert(next) }];
      }
      case 'tool.progress': {
        const p = parseEventPayload('tool.progress', event.payload);
        const existing = this.items.get(itemKey('tool', p.toolCallId));
        const next: Extract<UIItem, { kind: 'tool' }> = {
          kind: 'tool',
          id: p.toolCallId,
          tool: existing?.kind === 'tool' ? existing.tool : p.tool,
          ...(existing?.kind === 'tool' && existing.input !== undefined ? { input: existing.input } : {}),
          output: `${existing?.kind === 'tool' && existing.output ? `${existing.output}\n` : ''}${p.output}`,
          status: 'running',
          seq: existing?.kind === 'tool' ? existing.seq : event.id
        };
        return [{ kind: 'upsert', cursor: event.id, item: this.upsert(next) }];
      }
      case 'message.delta': {
        const p = parseEventPayload('message.delta', event.payload);
        const existing = this.findMessage(p.messageId);
        const artifact = existing?.parts.find((part) => part.type === 'artifact' && part.messageType === p.type);
        const parts = existing ? existing.parts.slice() : [];
        if (artifact?.type === 'artifact') artifact.text = `${artifact.text ?? ''}${p.delta}`;
        else parts.push({ type: 'artifact', messageType: p.type, text: p.delta });
        return [
          this.setMessage({
            kind: 'message',
            id: p.messageId,
            role: 'assistant',
            parts,
            status: 'streaming',
            seq: existing?.seq ?? event.at
          })
        ];
      }
      case 'message.complete': {
        const p = parseEventPayload('message.complete', event.payload);
        return [
          this.setMessage({
            kind: 'message',
            id: p.messageId,
            role: 'assistant',
            parts: [
              {
                type: 'artifact',
                messageType: p.type,
                ...(p.text ? { text: p.text } : {}),
                ...(p.data !== undefined ? { data: p.data } : {})
              }
            ],
            status: p.ok ? 'done' : 'error',
            seq: this.findMessage(p.messageId)?.seq ?? event.at
          })
        ];
      }
      case 'tool.approval_requested': {
        const p = parseEventPayload('tool.approval_requested', event.payload);
        return [
          {
            kind: 'upsert',
            cursor: event.id,
            item: this.upsert({
              kind: 'approval',
              id: p.requestId,
              tool: p.tool,
              ...(p.input !== undefined ? { input: p.input } : {}),
              ...(p.key ? { key: p.key } : {}),
              seq: event.id
            })
          }
        ];
      }
      case 'tool.approval_resolved': {
        const p = parseEventPayload('tool.approval_resolved', event.payload);
        return [this.remove('approval', p.requestId)];
      }
      case 'native_cli.started': {
        const p = parseEventPayload('native_cli.started', event.payload);
        return [
          {
            kind: 'upsert',
            cursor: event.id,
            item: this.upsert({
              kind: 'tool',
              id: p.nativeCliSessionId,
              tool: `native-cli:${p.provider}`,
              input: {
                agent: p.agentName,
                provider: p.provider,
                productIcon: p.productIcon,
                workingPath: p.workingPath,
                launchMode: p.launchMode,
                approvalOwnership: 'provider-owned'
              },
              status: 'running',
              seq: event.id
            })
          }
        ];
      }
      case 'native_cli.output': {
        const p = parseEventPayload('native_cli.output', event.payload);
        const existing = this.items.get(itemKey('tool', p.nativeCliSessionId));
        const output =
          existing?.kind === 'tool'
            ? appendBoundedText(existing.output ?? '', p.chunk, MAX_NATIVE_CLI_UI_OUTPUT)
            : p.chunk;
        const next: Extract<UIItem, { kind: 'tool' }> = {
          kind: 'tool',
          id: p.nativeCliSessionId,
          tool: existing?.kind === 'tool' ? existing.tool : 'native-cli',
          ...(existing?.kind === 'tool' && existing.input !== undefined ? { input: existing.input } : {}),
          output,
          status: existing?.kind === 'tool' ? existing.status : 'running',
          seq: existing?.kind === 'tool' ? existing.seq : event.id
        };
        return [{ kind: 'upsert', cursor: event.id, item: this.upsert(next) }];
      }
      case 'native_cli.connection_required': {
        const p = parseEventPayload('native_cli.connection_required', event.payload);
        return [
          {
            kind: 'upsert',
            cursor: event.id,
            item: this.upsert({
              kind: 'custom',
              id: `native-cli-connection-required:${p.nativeCliSessionId ?? p.agentName}`,
              name: 'native_cli.connection_required',
              status: 'error',
              data: p,
              seq: event.id
            })
          }
        ];
      }
      case 'native_cli.approval_requested': {
        const p = parseEventPayload('native_cli.approval_requested', event.payload);
        return [
          {
            kind: 'upsert',
            cursor: event.id,
            item: this.upsert({
              kind: 'approval',
              id: p.requestId,
              tool: `${p.provider} approval`,
              input: {
                nativeCliSessionId: p.nativeCliSessionId,
                provider: p.provider,
                text: p.text,
                data: p.data,
                approvalOwnership: 'provider-owned'
              },
              key: `provider-owned:${p.provider}`,
              seq: event.id
            })
          }
        ];
      }
      case 'native_cli.approval_resolved': {
        const p = parseEventPayload('native_cli.approval_resolved', event.payload);
        return [this.remove('approval', p.requestId)];
      }
      case 'native_cli.resume_failed': {
        const p = parseEventPayload('native_cli.resume_failed', event.payload);
        const label = findNativeCliProviderAdapter(p.provider)?.label ?? p.provider;
        return [
          {
            kind: 'upsert',
            cursor: event.id,
            item: this.upsert({
              kind: 'system',
              id: `native-cli-resume-failed:${p.agentName}:${p.providerSessionRef}`,
              text: `${label} resume failed for provider session ${p.providerSessionRef}; cold started a new runtime.`,
              level: 'warn',
              seq: event.id
            })
          }
        ];
      }
      case 'native_cli.exited': {
        const p = parseEventPayload('native_cli.exited', event.payload);
        const existing = this.items.get(itemKey('tool', p.nativeCliSessionId));
        const exitText = p.exitCode === null ? `\n${p.state}` : `\n${p.state} (${p.exitCode})`;
        const next: Extract<UIItem, { kind: 'tool' }> = {
          kind: 'tool',
          id: p.nativeCliSessionId,
          tool: existing?.kind === 'tool' ? existing.tool : 'native-cli',
          ...(existing?.kind === 'tool' && existing.input !== undefined ? { input: existing.input } : {}),
          output: `${existing?.kind === 'tool' && existing.output ? existing.output : ''}${exitText}`,
          status: p.state === 'failed' ? 'error' : 'ok',
          seq: existing?.kind === 'tool' ? existing.seq : event.id
        };
        return [{ kind: 'upsert', cursor: event.id, item: this.upsert(next) }];
      }
      case 'clarify.requested': {
        const p = parseEventPayload('clarify.requested', event.payload);
        return [
          {
            kind: 'upsert',
            cursor: event.id,
            item: this.upsert({
              kind: 'clarification',
              id: p.requestId,
              question: p.question,
              ...(p.options ? { options: p.options } : {}),
              ...(p.mode ? { mode: p.mode } : {}),
              ...(p.allowOther !== undefined ? { allowOther: p.allowOther } : {}),
              ...(p.asker ? { asker: p.asker } : {}),
              seq: event.id
            })
          }
        ];
      }
      case 'clarify.resolved': {
        const p = parseEventPayload('clarify.resolved', event.payload);
        return [this.remove('clarification', p.requestId)];
      }
      case 'context.usage': {
        const p = parseEventPayload('context.usage', event.payload);
        return [
          {
            kind: 'upsert',
            cursor: event.id,
            item: this.upsert({
              kind: 'context',
              id: 'context',
              usage: p,
              seq: event.id
            })
          }
        ];
      }
      case 'session.updated': {
        const p = parseEventPayload('session.updated', event.payload);
        return p.reset ? [this.clearItems()] : [];
      }
      case 'task.created': {
        const p = parseEventPayload('task.created', event.payload);
        return [this.setCustom({ id: p.taskId, name: event.type, data: p, status: 'streaming', seq: event.id })];
      }
      case 'task.progress': {
        const p = parseEventPayload('task.progress', event.payload);
        return [this.setCustom({ id: p.taskId, name: event.type, data: p, status: 'streaming', seq: event.id })];
      }
      case 'task.completed': {
        const p = parseEventPayload('task.completed', event.payload);
        return [this.setCustom({ id: p.taskId, name: event.type, data: p, status: 'done', seq: event.id })];
      }
      case 'task.failed': {
        const p = parseEventPayload('task.failed', event.payload);
        return [this.setCustom({ id: p.taskId, name: event.type, data: p, status: 'error', seq: event.id })];
      }
      case 'delegation.fs_request': {
        const p = parseEventPayload('delegation.fs_request', event.payload);
        return [this.setCustom({ id: p.requestId, name: event.type, data: p, status: 'streaming', seq: event.id })];
      }
      case 'delegation.terminal_request': {
        const p = parseEventPayload('delegation.terminal_request', event.payload);
        return [this.setCustom({ id: p.requestId, name: event.type, data: p, status: 'streaming', seq: event.id })];
      }
      default:
        return [];
    }
  }

  snapshot(opts: { hasMore?: boolean } = {}): SessionUiEvent {
    // From here on the initial view is committed; subsequent live growth may be evicted (see upsert).
    this.snapshotted = true;
    return {
      kind: 'snapshot',
      ...(this.lastCursor ? { cursor: this.lastCursor as `evt_${string}` } : {}),
      ...(this.oldestMessageId ? { oldestCursor: this.oldestMessageId as `msg_${string}` } : {}),
      ...(opts.hasMore ? { hasMore: true } : {}),
      items: this.order.map((key) => this.items.get(key)).filter((item): item is UIItem => item !== undefined)
    };
  }
}
