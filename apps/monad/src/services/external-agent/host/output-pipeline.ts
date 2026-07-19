import type { Logger } from '@monad/logger';
import type {
  LiveExternalAgentSession,
  ManagedProjectOutputHandler
} from '#/services/external-agent/host/host-types.ts';
import type { StructuredLineBufferState } from '#/services/external-agent/structured-lines.ts';
import type { ExternalAgentOutputEvent, ExternalAgentProviderAdapter } from '#/services/external-agent/types.ts';
import type { ExternalAgentTargetId } from '#/store/db/external-agent-sessions.ts';
import type { Store } from '#/store/db/index.ts';

import { ExternalAgentError } from '#/services/external-agent/errors.ts';
import { ExternalAgentEventLog } from '#/services/external-agent/host/event-log.ts';
import { type ExternalAgentOutputStream, MAX_STRUCTURED_LINE } from '#/services/external-agent/host/host-constants.ts';
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
    const live = this.ctx.live.get(id);
    if (!live) return;
    const capturedPayload = chunk;
    try {
      if (!live.liveRawStore) throw new Error('live observation store is unavailable');
      live.outputSeq = live.liveRawStore.append({
        stream,
        payload: capturedPayload,
        observedAt: new Date().toISOString()
      }).seq;
    } catch (error) {
      this.ctx.log.error(
        {
          event: 'external_agent.live_observation_store_write_failed',
          externalAgentSessionId: id,
          provider: live.provider,
          err: error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
        },
        'native cli live observation capture failed'
      );
      this.ctx.stop(id);
      throw error;
    }
    if (stream === 'app-server' && isAppServerControlResponse(chunk)) {
      for (const event of adapter.parseOutput(chunk, this.ctx.live.get(id))) {
        const parsed = externalAgentOutputEventSchema.safeParse(event);
        if (parsed.success) this.emitStructuredOutputEvent(transcriptTargetId, id, adapter, parsed.data);
      }
      return;
    }
    let structuredChunk =
      stream === 'pty' || stream === 'app-server' ? chunk : this.takeCompleteStructuredLines(id, stream, chunk);
    const protectsStructuredSeam =
      !!live?.providerHistoryIdentities?.size && (stream === 'stdout' || stream === 'stderr');
    if (protectsStructuredSeam && !structuredChunk) return;
    const providerObservation =
      live && stream !== 'pty' && structuredChunk
        ? this.trimProviderHistoryReplay(live, structuredChunk, stream === 'app-server')
        : undefined;
    if (live && providerObservation) {
      if (!providerObservation.chunk) return;
      if (protectsStructuredSeam) {
        structuredChunk = providerObservation.chunk;
      }
      live.providerHistoryCheckpoint = providerObservation.checkpoint ?? live.providerHistoryCheckpoint;
      live.providerHistoryIdentities ??= new Set();
      for (const identity of providerObservation.identities) live.providerHistoryIdentities.add(identity);
    }
    this.ctx.observation.publish(id);
    this.ctx.armIdleSuspend(live);
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

  private trimProviderHistoryReplay(
    live: LiveExternalAgentSession,
    chunk: string,
    framed: boolean
  ): { chunk: string; identities: string[]; checkpoint?: string } {
    const records = framed ? [chunk] : chunk.split(/(?<=\n)/).filter(Boolean);
    const retained: string[] = [];
    const identities: string[] = [];
    let checkpoint: string | undefined;
    for (const record of records) {
      const events = live.adapter.events.projectLive({ id: `${live.id}:seam`, output: record }).events;
      const keys = events.map((event) => event.dedupeKey).filter((value): value is string => !!value);
      if (keys.length > 0 && keys.every((identity) => live.providerHistoryIdentities?.has(identity))) continue;
      retained.push(record);
      identities.push(...keys);
      checkpoint = events.findLast((event) => event.dedupeKey)?.dedupeKey ?? checkpoint;
    }
    return { chunk: retained.join(''), identities, checkpoint };
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
      pending.resolve({
        items,
        ...(typeof event.payload.nextCursor === 'string' ? { nextCursor: event.payload.nextCursor } : {})
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

function isAppServerControlResponse(frame: string): boolean {
  try {
    const value = JSON.parse(frame) as Record<string, unknown>;
    return (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      value.id !== undefined &&
      typeof value.method !== 'string' &&
      ('result' in value || 'error' in value)
    );
  } catch {
    return false;
  }
}
