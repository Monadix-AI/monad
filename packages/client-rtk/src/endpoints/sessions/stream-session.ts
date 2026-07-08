import {
  type ChatMessage,
  type ContextUsagePayload,
  type Event,
  parseEventPayload,
  type SessionId,
  type UIToolItem
} from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf } from '../../endpoint-helpers.ts';
import { sendMessageApi } from './send-message.ts';

interface StreamMessage {
  id: string;
  role: Extract<ChatMessage['role'], 'user' | 'assistant'>;
  text: ChatMessage['text'];
  agentName?: string;
  reasoning?: string;
  error?: boolean;
  /** True while this assistant text segment is still streaming (its agent.token is in flight). The
   * turn's final agent.message clears it. Lets the UI show a live cursor and keep an in-flight
   * segment distinct from a settled one. */
  streaming?: boolean;
  /** Arrival order (the creating event's monotonic id) so the UI can interleave in-flight text
   * segments with tool steps by when they actually happened, not by which array they live in. */
  seq?: string;
  // For a generative non-assistant message streamed over message.delta: its type + settled data,
  // so a client can render it richly (degrading via the shared registry) while it generates.
  type?: ChatMessage['type'];
  data?: ChatMessage['data'];
}

interface PendingApproval {
  requestId: string;
  tool: string;
  input?: unknown;
  /** Gate key (e.g. `host-control` for desktop control), when set — lets the UI label the prompt
   *  and steer the grant scope. */
  key?: string;
}

/** A free-text question the agent is blocked on (clarify.requested), answered via clarify.respond. */
interface PendingClarification {
  requestId: string;
  question: string;
  options?: string[];
}

/** One tool step in the live agent loop: emitted as `tool.called` (running) then `tool.result`
 *  (ok/error). Mirrors the persisted `tool_call`/`tool_result` history rows so the UI can show the
 *  loop's progress mid-turn and the same view from history afterwards. */
interface ToolStep {
  id: UIToolItem['id']; // toolCallId
  tool: UIToolItem['tool'];
  input?: UIToolItem['input'];
  status: UIToolItem['status'];
  output?: UIToolItem['output'];
  errorCode?: UIToolItem['errorCode'];
  /** Arrival order (the `tool.called` event's id) — see StreamMessage.seq. */
  seq?: UIToolItem['seq'];
}

interface SessionStreamState {
  messages: StreamMessage[];
  toolSteps: ToolStep[];
  pendingApprovals: PendingApproval[];
  pendingClarifications: PendingClarification[];
  usage?: ContextUsagePayload;
  /** Set when the SSE stream errors; cleared once events flow again. Lets the UI show a
   *  "reconnecting…" / failed state instead of a silently frozen transcript. `fatal` won't retry. */
  streamError?: { kind: 'fatal' | 'transient'; status?: number };
}

// Cap on the live stream cache. History (refetched on each turn's settle) is the canonical store, so
// this only needs to hold the current turn's in-flight items plus a small bridge — far below the cap.
const STREAM_MESSAGE_CAP = 100;

export const streamSessionApi = sendMessageApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    streamSession: builder.query<SessionStreamState, SessionId>({
      queryFn: () => ({ data: { messages: [], toolSteps: [], pendingApprovals: [], pendingClarifications: [] } }),
      async onCacheEntryAdded(
        sessionId: SessionId,
        {
          cacheDataLoaded,
          cacheEntryRemoved,
          updateCachedData,
          dispatch,
          extra
        }: {
          cacheDataLoaded: Promise<unknown>;
          cacheEntryRemoved: Promise<unknown>;
          updateCachedData: (fn: (draft: SessionStreamState) => void) => void;
          dispatch: (action: unknown) => void;
          extra: unknown;
        }
      ) {
        const client = clientOf({ extra });
        let dispose: (() => void) | undefined;
        try {
          await cacheDataLoaded;
          const seen = new Set<string>();
          dispose = client.streamEvents(
            sessionId,
            (event: Event) => {
              updateCachedData((draft) => {
                if (draft.streamError) draft.streamError = undefined; // events flowing again → clear
                switch (event.type) {
                  case 'user.message': {
                    const p = parseEventPayload('user.message', event.payload);
                    if (!seen.has(p.messageId)) {
                      seen.add(p.messageId);
                      draft.messages.push({ id: p.messageId, role: 'user', text: p.text, seq: event.id });
                    }
                    break;
                  }
                  case 'agent.token': {
                    // Each assistant text SEGMENT carries its own messageId (a turn's `text → tool → text`
                    // streams as distinct segments). Bucket by messageId so they render as separate
                    // ordered bubbles instead of one flattened string.
                    const p = parseEventPayload('agent.token', event.payload);
                    const existing = draft.messages.find((m) => m.id === p.messageId);
                    if (existing) existing.text += p.delta;
                    else
                      draft.messages.push({
                        id: p.messageId,
                        role: 'assistant',
                        agentName: p.agentName,
                        text: p.delta,
                        streaming: true,
                        seq: event.id
                      });
                    if (existing && p.agentName) existing.agentName = p.agentName;
                    break;
                  }
                  case 'agent.reasoning': {
                    // Reasoning streams ahead of (and shares the messageId of) its text segment — bucket
                    // it onto that segment so each bubble shows its own thinking, like the text.
                    const p = parseEventPayload('agent.reasoning', event.payload);
                    const existing = draft.messages.find((m) => m.id === p.messageId);
                    if (existing) existing.reasoning = (existing.reasoning ?? '') + p.delta;
                    else
                      draft.messages.push({
                        id: p.messageId,
                        role: 'assistant',
                        text: '',
                        reasoning: p.delta,
                        streaming: true,
                        seq: event.id
                      });
                    break;
                  }
                  case 'agent.message': {
                    // Finalize the turn's last text segment (text + reasoning already bucketed) and clear
                    // lingering streaming flags; history refetch below is the canonical view.
                    const p = parseEventPayload('agent.message', event.payload);
                    const existing = draft.messages.find((m) => m.id === p.messageId);
                    if (existing) {
                      existing.text = p.text;
                      if (p.agentName) existing.agentName = p.agentName;
                    } else if (!seen.has(p.messageId)) {
                      seen.add(p.messageId);
                      draft.messages.push({
                        id: p.messageId,
                        role: 'assistant',
                        agentName: p.agentName,
                        text: p.text,
                        seq: event.id
                      });
                    }
                    for (const m of draft.messages) if (m.streaming) m.streaming = false;
                    // History carries the canonical, ordered tool turns; drop live steps to avoid rendering them twice.
                    draft.toolSteps = [];
                    // Pull the canonical, ordered history (incl. tool turns) once the turn lands.
                    dispatch(apiSlice.util.invalidateTags([{ type: 'Messages', id: sessionId }]));
                    break;
                  }
                  case 'tool.called': {
                    const p = parseEventPayload('tool.called', event.payload);
                    if (!draft.toolSteps.some((s) => s.id === p.toolCallId)) {
                      draft.toolSteps.push({
                        id: p.toolCallId,
                        tool: p.tool,
                        input: p.input,
                        status: 'running',
                        seq: event.id
                      });
                    }
                    // Model has moved from text generation to tool execution — clear the blinking cursor.
                    for (const m of draft.messages) if (m.streaming) m.streaming = false;
                    break;
                  }
                  case 'tool.result': {
                    const p = parseEventPayload('tool.result', event.payload);
                    const step = draft.toolSteps.find((s) => s.id === p.toolCallId);
                    if (step) {
                      step.status = p.ok ? 'ok' : 'error';
                      step.output = p.displayResult ?? p.result;
                      step.errorCode = p.errorCode;
                    }
                    break;
                  }
                  case 'message.delta': {
                    // A non-assistant generative message (e.g. a card) streaming over its own channel.
                    // Upsert a draft by messageId so it renders progressively; type drives the renderer.
                    const p = parseEventPayload('message.delta', event.payload);
                    const existing = draft.messages.find((m) => m.id === p.messageId);
                    if (existing) existing.text += p.delta;
                    else
                      draft.messages.push({
                        id: p.messageId,
                        role: 'assistant',
                        text: p.delta,
                        type: p.type,
                        seq: event.id
                      });
                    break;
                  }
                  case 'message.complete': {
                    const p = parseEventPayload('message.complete', event.payload);
                    const existing = draft.messages.find((m) => m.id === p.messageId);
                    if (existing) {
                      existing.text = p.text;
                      existing.type = p.type;
                      existing.data = p.data;
                      existing.error = !p.ok;
                    } else if (!seen.has(p.messageId)) {
                      seen.add(p.messageId);
                      draft.messages.push({
                        id: p.messageId,
                        role: 'assistant',
                        text: p.text,
                        type: p.type,
                        data: p.data,
                        error: !p.ok
                      });
                    }
                    // Pull the canonical persisted row (with final data) once it settles.
                    dispatch(apiSlice.util.invalidateTags([{ type: 'Messages', id: sessionId }]));
                    break;
                  }
                  case 'context.usage': {
                    draft.usage = parseEventPayload('context.usage', event.payload);
                    break;
                  }
                  case 'tool.approval_requested': {
                    const p = parseEventPayload('tool.approval_requested', event.payload);
                    if (!draft.pendingApprovals.some((a) => a.requestId === p.requestId)) {
                      draft.pendingApprovals.push({ requestId: p.requestId, tool: p.tool, input: p.input, key: p.key });
                    }
                    break;
                  }
                  case 'tool.approval_resolved': {
                    const p = parseEventPayload('tool.approval_resolved', event.payload);
                    draft.pendingApprovals = draft.pendingApprovals.filter((a) => a.requestId !== p.requestId);
                    break;
                  }
                  case 'clarify.requested': {
                    const p = parseEventPayload('clarify.requested', event.payload);
                    if (!draft.pendingClarifications.some((c) => c.requestId === p.requestId)) {
                      draft.pendingClarifications.push({
                        requestId: p.requestId,
                        question: p.question,
                        options: p.options
                      });
                    }
                    break;
                  }
                  case 'clarify.resolved': {
                    const p = parseEventPayload('clarify.resolved', event.payload);
                    draft.pendingClarifications = draft.pendingClarifications.filter(
                      (c) => c.requestId !== p.requestId
                    );
                    break;
                  }
                  case 'agent.error': {
                    const p = parseEventPayload('agent.error', event.payload);
                    const id = p.messageId ?? `err-${event.id}`;
                    if (!seen.has(id)) {
                      seen.add(id);
                      const text = p.code ? `[${p.code}] ${p.message}` : p.message;
                      draft.messages.push({ id, role: 'assistant', agentName: p.agentName, text, error: true });
                    }
                    for (const m of draft.messages) if (m.streaming) m.streaming = false;
                    draft.toolSteps = [];
                    break;
                  }
                }
                // Bound the live stream cache: older settled messages are owned by history (refetched
                // on settle), so dropping them frees memory without losing anything from the view.
                if (draft.messages.length > STREAM_MESSAGE_CAP) {
                  draft.messages.splice(0, draft.messages.length - STREAM_MESSAGE_CAP);
                }
              });
            },
            {
              // Clear the "reconnecting…" banner the moment the socket is back, even between turns
              // when no event flows to trigger the in-handler clear above.
              onOpen: () =>
                updateCachedData((draft) => {
                  if (draft.streamError) draft.streamError = undefined;
                }),
              onError: (err) =>
                updateCachedData((draft) => {
                  draft.streamError = { kind: err.kind, status: err.status };
                })
            }
          );
        } catch {
          // cacheDataLoaded rejects when the entry is removed before it loads
        }
        await cacheEntryRemoved;
        dispose?.();
      }
    })
  })
});

export const { useStreamSessionQuery } = streamSessionApi;
