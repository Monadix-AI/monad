import type { Logger } from '@monad/logger';
import type { ExternalAgentHistoryPageRequest } from '@monad/protocol';
import type {
  LiveExternalAgentSession,
  ManagedProjectOutputHandler
} from '#/services/external-agent/host/host-types.ts';
import type { StructuredLineBufferState } from '#/services/external-agent/structured-lines.ts';
import type { ExternalAgentOutputEvent, ExternalAgentProviderAdapter } from '#/services/external-agent/types.ts';
import type { ExternalAgentTargetId } from '#/store/db/external-agent-sessions.ts';
import type { Store } from '#/store/db/index.ts';

import { externalAgentStreamItems } from '@monad/atoms/external-agent-observation';

import { MAX_OUTPUT_SNAPSHOT } from '#/services/external-agent/constants.ts';
import { ExternalAgentError } from '#/services/external-agent/errors.ts';
import { ExternalAgentEventLog } from '#/services/external-agent/host/event-log.ts';
import { encodeProviderHistoryCursor } from '#/services/external-agent/host/history-cursor.ts';
import {
  type ExternalAgentOutputStream,
  MAX_STRUCTURED_LINE,
  SNAPSHOT_FLUSH_MS
} from '#/services/external-agent/host/host-constants.ts';
import { externalAgentApprovalText, nativeAgentMcpToolError } from '#/services/external-agent/host/host-helpers.ts';
import { ExternalAgentObservationHub } from '#/services/external-agent/host/observation-hub.ts';
import { createStreamingTextDecoder } from '#/services/external-agent/stream-decoder.ts';
import { takeCompleteStructuredLines } from '#/services/external-agent/structured-lines.ts';
import { externalAgentOutputEventSchema } from '#/services/external-agent/types.ts';

export interface ExternalAgentOutputPipelineContext {
  live: Map<string, LiveExternalAgentSession>;
  store: Pick<
    Store,
    | 'getExternalAgentSession'
    | 'appendExternalAgentOutput'
    | 'setExternalAgentOutputSnapshot'
    | 'updateExternalAgentSessionRef'
    | 'hasUnconsumedExternalAgentInbox'
    | 'markExternalAgentInboxConsumed'
  >;
  events: ExternalAgentEventLog;
  observation: ExternalAgentObservationHub;
  stop(id: string): void;
  getManagedProjectOutputHandler(): ManagedProjectOutputHandler | null;
  log: Logger;
  /** Reset the session's idle-suspend timer — output is activity, same as user input. */
  armIdleSuspend(live: LiveExternalAgentSession): void;
  /** Reshape raw provider history-page items into the live-JSONL-mimicking output string the adapter's
   *  `parseOutput`/`externalAgentStreamItems` normalize — same adapter the host already resolved for this
   *  session. Returns undefined when the adapter/session don't support it (falls back to raw-line join). */
  historyPageOutput(
    live: LiveExternalAgentSession,
    request: ExternalAgentHistoryPageRequest,
    items: unknown[]
  ): string | undefined;
}

/** Owns the child-process output path end to end: draining stdio into text, buffering/flushing the
 *  bounded output snapshot, publishing live output over the bus, and decoding the newline-delimited
 *  structured events providers emit into their concrete daemon-side effects (session-ref capture,
 *  paged history, approvals, managed-project posting). */
export class ExternalAgentOutputPipeline {
  private readonly structuredOutputBuffers = new Map<
    string,
    Partial<Record<ExternalAgentOutputStream, StructuredLineBufferState>>
  >();

  constructor(private readonly ctx: ExternalAgentOutputPipelineContext) {}

  readPipe(
    transcriptTargetId: ExternalAgentTargetId,
    id: string,
    stream: ReadableStream<Uint8Array> | undefined,
    name: 'stdout' | 'stderr',
    adapter: ExternalAgentProviderAdapter
  ): void {
    if (!stream) return;
    const decoder = createStreamingTextDecoder();
    void (async () => {
      for await (const data of stream) {
        const text = decoder.decode(data);
        if (text) this.output(transcriptTargetId, id, text, name, adapter);
      }
      const remainingText = decoder.flush();
      if (remainingText) this.output(transcriptTargetId, id, remainingText, name, adapter);
    })();
  }

  dropStructuredBuffer(id: string): void {
    this.structuredOutputBuffers.delete(id);
  }

  output(
    transcriptTargetId: ExternalAgentTargetId,
    id: string,
    chunk: string,
    // 'app-server' is a single pre-framed JSON-RPC message (one ws text frame) — already a complete
    // line, so it skips the newline-reassembly buffer that stdout/stderr byte chunks need.
    stream: 'stdout' | 'stderr' | 'pty' | 'app-server',
    adapter: ExternalAgentProviderAdapter
  ): void {
    // Keep the observation snapshot newline-delimited so the web parser can split records; a ws frame
    // carries no trailing newline of its own.
    const buffered = stream === 'app-server' ? `${chunk}\n` : chunk;
    const live = this.ctx.live.get(id);
    if (live) {
      // Accumulate in memory and flush the bounded snapshot to SQLite on a timer — avoids a
      // per-chunk 256 KB read-modify-write under a chatty agent.
      if (stream === 'app-server') live.outputBuffer.appendFrame(buffered);
      else live.outputBuffer.append(buffered);
      live.outputSeq += buffered.length;
      this.scheduleSnapshotFlush(id);
      this.ctx.observation.publish(id);
      this.ctx.armIdleSuspend(live);
    } else {
      const row = this.ctx.store.getExternalAgentSession(id);
      if (row) this.ctx.store.appendExternalAgentOutput(id, buffered, MAX_OUTPUT_SNAPSHOT);
    }
    this.ctx.events.publish(transcriptTargetId, 'external_agent.output', {
      externalAgentSessionId: id,
      stream: stream === 'app-server' ? 'stdout' : stream,
      chunk: buffered
    });
    const structuredChunk =
      stream === 'pty' || stream === 'app-server' ? chunk : this.takeCompleteStructuredLines(id, stream, chunk);
    if (!structuredChunk) return;
    if (stream === 'stderr') {
      for (const line of structuredChunk.split('\n')) {
        const record = nativeAgentMcpToolError(line.trim());
        if (!record) continue;
        const liveSession = this.ctx.live.get(id);
        this.ctx.log.error(
          {
            ...record,
            transcriptTargetId,
            externalAgentSessionId: id,
            agentName: liveSession?.agentName,
            provider: liveSession?.provider
          },
          'managed native cli agent-facing MCP tool failed'
        );
      }
    }
    for (const event of adapter.parseOutput(structuredChunk, this.ctx.live.get(id))) {
      const parsed = externalAgentOutputEventSchema.safeParse(event);
      if (!parsed.success) continue;
      this.emitStructuredOutputEvent(transcriptTargetId, id, adapter, parsed.data);
    }
  }

  private scheduleSnapshotFlush(id: string): void {
    const live = this.ctx.live.get(id);
    if (!live || live.snapshotFlushTimer) return;
    live.snapshotFlushTimer = setTimeout(() => {
      const current = this.ctx.live.get(id);
      if (current) current.snapshotFlushTimer = null;
      this.flushSnapshot(id);
    }, SNAPSHOT_FLUSH_MS);
  }

  /** Persist the in-memory snapshot now and cancel any pending flush. Called on the timer and once
   *  more on exit/stop so the final output isn't lost. */
  flushSnapshot(id: string): void {
    const live = this.ctx.live.get(id);
    if (!live) return;
    if (live.snapshotFlushTimer) {
      clearTimeout(live.snapshotFlushTimer);
      live.snapshotFlushTimer = null;
    }
    this.ctx.store.setExternalAgentOutputSnapshot(id, live.outputBuffer.snapshot(), MAX_OUTPUT_SNAPSHOT);
  }

  takeCompleteStructuredLines(id: string, stream: 'stdout' | 'stderr', chunk: string): string {
    const buffers = this.structuredOutputBuffers.get(id) ?? {};
    const state = buffers[stream] ?? { text: '', discarding: false };
    const completeLines = takeCompleteStructuredLines(state, chunk, MAX_STRUCTURED_LINE);
    buffers[stream] = state;
    this.structuredOutputBuffers.set(id, buffers);
    return completeLines;
  }

  private emitStructuredOutputEvent(
    transcriptTargetId: ExternalAgentTargetId,
    id: string,
    adapter: ExternalAgentProviderAdapter,
    event: ExternalAgentOutputEvent
  ): void {
    if (event.type === 'agent_message') {
      // A managed provider's own message is diagnostic output — observable through the external_agent
      // output card, never auto-posted to the Workplace Project wall. A reply reaches the room only
      // when the agent explicitly posts via the bridge (`monad project post`), which the wake notice
      // instructs it to do. This keeps every provider consistent (codex never carried a terminal
      // `final` marker) and avoids double-posting the same text via both paths. Errors still surface
      // below via the provider_error branch.
      if (event.payload.final === true) {
        this.emitManagedProjectOutput(
          transcriptTargetId,
          id,
          typeof event.payload.text === 'string' ? event.payload.text : '',
          false,
          false
        );
      }
      return;
    }

    if (event.type === 'session_ref') {
      const providerSessionRef =
        typeof event.payload.providerSessionRef === 'string' ? event.payload.providerSessionRef : undefined;
      if (providerSessionRef) {
        const live = this.ctx.live.get(id);
        if (live) {
          live.providerSessionRef = providerSessionRef;
          if (live.startup) {
            clearTimeout(live.startup.timeout);
            live.startup.resolve(providerSessionRef);
            live.startup = undefined;
          }
        }
        this.ctx.store.updateExternalAgentSessionRef(id, providerSessionRef);
      }
      return;
    }

    if (event.type === 'history_page') {
      const responseId =
        typeof event.payload.responseId === 'string' ? event.payload.responseId : String(event.payload.responseId);
      const live = this.ctx.live.get(id);
      const pending = live?.pendingHistoryPages.get(responseId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      live?.pendingHistoryPages.delete(responseId);
      const items = Array.isArray(event.payload.items) ? event.payload.items : [];
      const output = live ? this.ctx.historyPageOutput(live, pending.request, items) : undefined;
      // The daemon already knows `live.provider`/`live.adapter`, so normalize here instead of shipping
      // raw items for the client to guess a provider for. Raw JSONL isn't shipped separately: each
      // event's `raw` already carries its source record(s).
      const pageOutput =
        output ?? items.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join('\n');
      pending.resolve({
        events: live
          ? externalAgentStreamItems({ id: `${id}:history:live`, adapter: live.adapter, output: pageOutput })
          : [],
        ...(typeof event.payload.nextCursor === 'string'
          ? { nextCursor: encodeProviderHistoryCursor(event.payload.nextCursor) }
          : {})
      });
      return;
    }

    if (event.type === 'connection_required') {
      const live = this.ctx.live.get(id);
      this.ctx.events.emit(transcriptTargetId, 'external_agent.connection_required', {
        externalAgentSessionId: id,
        agentName: live?.agentName ?? adapter.provider,
        provider: adapter.provider,
        code:
          typeof event.payload.code === 'string' && event.payload.code.length > 0
            ? event.payload.code
            : 'provider_connection_required',
        reason:
          typeof event.payload.reason === 'string'
            ? event.payload.reason
            : `${adapter.provider} requires reconnect in Studio`,
        reconnectIn: 'studio'
      });
      this.ctx.stop(id);
      return;
    }

    if (event.type === 'provider_error') {
      const live = this.ctx.live.get(id);
      const message =
        typeof event.payload.message === 'string' ? event.payload.message : `${adapter.provider} provider error`;
      // An error response to an in-flight history-page request must reject that caller immediately —
      // otherwise the pending promise silently runs into HISTORY_PAGE_TIMEOUT_MS and the client sees a
      // misleading provider_timeout. It is a request-scoped read failure, not session output, so it is
      // not mirrored to stderr or the project wall.
      if (live && event.payload.responseId !== undefined) {
        const errorResponseId = String(event.payload.responseId);
        const pendingHistory = live.pendingHistoryPages.get(errorResponseId);
        if (pendingHistory) {
          clearTimeout(pendingHistory.timeout);
          live.pendingHistoryPages.delete(errorResponseId);
          pendingHistory.reject(new ExternalAgentError('provider_protocol_error', message));
          return;
        }
      }
      if (live?.startup) {
        clearTimeout(live.startup.timeout);
        live.startup.reject(new ExternalAgentError('provider_protocol_error', message));
        live.startup = undefined;
      }
      this.ctx.events.emit(transcriptTargetId, 'external_agent.output', {
        externalAgentSessionId: id,
        stream: 'stderr',
        chunk: message,
        provider: adapter.provider,
        code: event.payload.code,
        responseId: event.payload.responseId
      });
      this.emitManagedProjectOutput(transcriptTargetId, id, message, true);
      return;
    }

    if (event.type === 'approval_requested') {
      const requestId =
        typeof event.payload.requestId === 'string' ? event.payload.requestId : String(event.payload.requestId);
      const live = this.ctx.live.get(id);
      // Autopilot managed sessions auto-deny any approval that leaks past the skip flag. A managed
      // session that delegates approvals (autopilot off + resolvable adapter) instead falls through
      // to the same projection path interactive sessions use — monad is only the UI proxy.
      if (live?.runtimeRole === 'managed-project-agent' && !live.proxyApprovals) {
        const text = externalAgentApprovalText(event);
        try {
          live.adapter.resolveApproval(live, {
            requestId,
            allow: false,
            reason: 'managed project external agent provider approvals are disabled',
            request: event.payload
          });
        } catch (err) {
          this.ctx.log.debug(
            {
              sessionId: transcriptTargetId,
              event: 'external_agent.managed_project_provider_approval_suppress_error',
              externalAgentSessionId: id,
              provider: adapter.provider,
              requestId,
              text,
              err: err instanceof Error ? { message: err.message, stack: err.stack } : String(err)
            },
            'managed native cli provider approval suppress failed'
          );
        }
        this.ctx.log.debug(
          {
            sessionId: transcriptTargetId,
            event: 'external_agent.managed_project_provider_approval_suppressed',
            externalAgentSessionId: id,
            provider: adapter.provider,
            requestId,
            text
          },
          'managed native cli provider approval suppressed'
        );
        return;
      }
      if (live?.pendingApprovals.has(requestId)) return;
      live?.pendingApprovals.set(requestId, event.payload);
      this.ctx.events.emit(transcriptTargetId, 'external_agent.approval_requested', {
        externalAgentSessionId: id,
        provider: adapter.provider,
        requestId,
        text: externalAgentApprovalText(event),
        data: event.payload
      });
      return;
    }

    if (event.type === 'approval_resolved') {
      const requestId =
        typeof event.payload.requestId === 'string' ? event.payload.requestId : String(event.payload.requestId);
      const live = this.ctx.live.get(id);
      if (!live?.pendingApprovals.has(requestId)) return;
      live.pendingApprovals.delete(requestId);
      this.ctx.events.emit(transcriptTargetId, 'external_agent.approval_resolved', {
        externalAgentSessionId: id,
        provider: adapter.provider,
        requestId,
        allow: event.payload.allow !== false,
        ...(typeof event.payload.reason === 'string' ? { reason: event.payload.reason } : {})
      });
    }
  }

  emitManagedProjectOutput(
    transcriptTargetId: ExternalAgentTargetId,
    id: string,
    text: string,
    error = false,
    post = true
  ): void {
    const live = this.ctx.live.get(id);
    const row = this.ctx.store.getExternalAgentSession(id);
    const runtimeRole = live?.runtimeRole ?? row?.runtimeRole;
    if (runtimeRole !== 'managed-project-agent') return;
    if (post && !this.ctx.store.hasUnconsumedExternalAgentInbox(id)) return;
    const agentName = live?.agentName ?? row?.agentName;
    const managedProjectOutputHandler = this.ctx.getManagedProjectOutputHandler();
    if (!agentName || !managedProjectOutputHandler) return;
    // Consume only what the agent actually saw in its input (visible), never items merely
    // delivered mid-turn (busy notice sent without the message body) — those must survive
    // this turn's settle so a later wake or `monad project inbox` can still surface them.
    const cursor = row?.lastVisibleSeq ?? 0;
    if (cursor > 0) this.ctx.store.markExternalAgentInboxConsumed(id, cursor);
    void Promise.resolve(
      managedProjectOutputHandler({
        sessionId: transcriptTargetId,
        externalAgentSessionId: id,
        agentName,
        text,
        error,
        post
      })
    ).catch((err: unknown) => {
      this.ctx.log.debug(
        {
          sessionId: transcriptTargetId,
          event: 'external_agent.managed_project_output_error',
          externalAgentSessionId: id,
          agentName,
          err: err instanceof Error ? { message: err.message, stack: err.stack } : String(err)
        },
        'managed native cli provider output failed to project'
      );
    });
  }
}
