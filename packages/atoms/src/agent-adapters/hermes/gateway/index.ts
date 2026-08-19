import type { MeshAgentOutputEvent } from '@monad/sdk-atom';
import type { GatewayHooks } from '../../gateway/hooks.ts';
import type {
  GatewayApprovalResolution as MeshAgentApprovalResolution,
  GatewayInitializeContext as MeshAgentInitializeContext,
  GatewayRuntimeHandle as MeshAgentRuntimeHandle
} from '../../gateway/runtime.ts';

import { meshAgentSessionUsageSchema } from '@monad/protocol';
import { z } from 'zod';

import { compactObject, parseJsonObject, recordValue } from '../../shared/adapter-shared.ts';
import { jsonRpcRequest } from '../../shared/transports/jsonrpc.ts';

// Hermes's real gateway (`hermes serve`, default ws://127.0.0.1:9119, path `/api/ws`) speaks genuine
// JSON-RPC 2.0 for requests/responses (`{id, method, params}` / `{id, result}` / `{id, error}` — the
// `"jsonrpc":"2.0"` field the server itself sends back is not required on requests, `_normalize_request`
// never checks for it), BUT wraps every server→client notification as
// `{method:"event", params:{type, session_id, payload}}` — the actual event name lives in `params.type`,
// not the frame's top-level `method`. That breaks the shared `AppServerProtocol`/`makeAppServerProtocol`
// dispatcher (which keys notifications by `frame.method` directly), so — like OpenClaw — this is
// hand-written hooks. Verified 2026-07-04 by reading the real dispatcher source shipped with the
// upgraded CLI (v0.18.0; the gateway didn't exist yet in the previously-installed v0.14.0):
// ~/.hermes/hermes-agent/tui_gateway/server.py (method table via `@method(...)`, `_emit`/`_ok`/`_err`)
// and hermes_cli/web_server.py (the `/api/ws` route + `_ws_auth_reason`).
//
// Session identity is two-layered: `session.create`/`session.resume` return BOTH an ephemeral
// `session_id` (an in-memory uuid4 hex[:8] scoped to THIS gateway connection — every other call in the
// same connection, e.g. `prompt.submit`/`approval.respond`, addresses turns to this) and a persistent
// `stored_session_id` (create) / `session_key` (resume's `_live_session_payload` — same value, different
// field name between the two methods, confirmed from source) that survives across connections/restarts.
// `providerSessionRef` on the handle carries the PERSISTENT id; the ephemeral id is tracked in a side
// map here since it's connection-scoped, not something the host's generic handle state models.
//
// Auth: a WS query-string param `?token=<value>`, compared against the gateway's own
// `HERMES_DASHBOARD_SESSION_TOKEN` env var (or a random per-process secret if unset) — NOT a JSON
// handshake field (web_server.py:269, `_ws_auth_reason`). On the default loopback bind this is
// enforced via `hmac.compare_digest`, so a real Hermes deployment DOES require a token even locally
// (unlike OpenClaw's loopback exemption) — the adapter surfaces `HERMES_DASHBOARD_SESSION_TOKEN` from
// `agent.env` both into the spawned process's env and onto the WebSocket channel query.

const ephemeralSessionIds = new WeakMap<MeshAgentRuntimeHandle, string>();
// Hermes has no per-approval id (`approval.respond` is `{session_id, choice}`), but the host dedupes
// in-flight approvals by `requestId` (packages/atoms/src/agent-adapters/openclaw and callers assume it's
// unique per pending approval) — a second `approval.request` for the same session while the first is
// still pending would collide on the bare session id and get silently dropped. Suffix a per-handle
// counter so overlapping requests get distinct ids; `resolveHermesApproval` never needs to decode this
// back into a session id (it already tracks that separately via `ephemeralSessionIds`).
const approvalSeqByHandle = new WeakMap<MeshAgentRuntimeHandle, number>();

interface HermesFrame extends Record<string, unknown> {
  method?: string;
  id?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

const hermesSessionUsagePayloadSchema = z
  .object({
    usage: z
      .object({
        input: z.number().finite().nonnegative(),
        output: z.number().finite().nonnegative(),
        reasoning: z.number().finite().nonnegative().optional(),
        total: z.number().finite().nonnegative(),
        context_used: z.number().finite().nonnegative().optional(),
        context_max: z.number().finite().positive().optional()
      })
      .catchall(z.unknown())
  })
  .catchall(z.unknown());

function idKeyOf(frame: HermesFrame): string | number | undefined {
  return typeof frame.id === 'string' || typeof frame.id === 'number' ? frame.id : undefined;
}

export function hermesInitialize(handle: MeshAgentRuntimeHandle, context: MeshAgentInitializeContext): void {
  if (!handle.gateway) return;
  // No separate handshake step (unlike OpenClaw's `connect`/codex's `initialize`) — the WS upgrade
  // itself carries auth via the query string, so `session.create`/`.resume` can go out immediately.
  const id = handle.nextRequestId?.() ?? 0;
  handle.pendingRequests?.set(id, context.providerSessionRef ? 'sessionResume' : 'sessionStart');
  if (context.providerSessionRef) {
    handle.gateway.send(jsonRpcRequest('session.resume', id, { session_id: context.providerSessionRef }));
    return;
  }
  handle.gateway.send(
    jsonRpcRequest('session.create', id, compactObject({ cwd: context.workingPath, source: 'monad' }))
  );
}

function responseEvents(frame: HermesFrame, handle?: MeshAgentRuntimeHandle): MeshAgentOutputEvent[] {
  const idKey = idKeyOf(frame);
  const kind = idKey !== undefined ? handle?.pendingRequests?.get(idKey) : undefined;
  if (idKey !== undefined && kind !== undefined) handle?.pendingRequests?.delete(idKey);

  const error = recordValue(frame.error);
  if (error) {
    if (kind === 'sessionStart' || kind === 'sessionResume') {
      return [
        {
          type: 'connection_required',
          payload: compactObject({
            code: typeof error.code === 'string' || typeof error.code === 'number' ? String(error.code) : undefined,
            reason:
              typeof error.message === 'string' && error.message.length > 0
                ? error.message
                : 'Hermes requires reconnect'
          })
        }
      ];
    }
    return [
      {
        type: 'provider_error',
        payload: compactObject({
          responseId: idKey,
          code: error.code,
          message: typeof error.message === 'string' ? error.message : JSON.stringify(error)
        })
      }
    ];
  }

  const result = recordValue(frame.result);
  if (kind === 'sessionStart' || kind === 'sessionResume') {
    const ephemeralId = result?.session_id;
    const persistentKey = result?.stored_session_id ?? result?.session_key;
    if (typeof ephemeralId === 'string' && ephemeralId.length > 0 && handle) {
      ephemeralSessionIds.set(handle, ephemeralId);
    }
    return typeof persistentKey === 'string' && persistentKey.length > 0
      ? [{ type: 'session_ref', payload: compactObject({ providerSessionRef: persistentKey, responseId: idKey }) }]
      : [];
  }
  // `prompt.submit`'s ack (`{status:"streaming"}`) and `approval.respond`'s (`{resolved}`) carry no
  // user-facing content themselves — turn text arrives via subsequent `event` frames. Surface the
  // latter as `approval_resolved` (Hermes has no separate resolved-notification; resolution is this
  // response) using the requestId threaded through `resolveHermesApproval`'s pendingRequests entry.
  if (typeof kind === 'string' && kind.startsWith('approvalRespond:')) {
    return [{ type: 'approval_resolved', payload: { requestId: kind.slice('approvalRespond:'.length) } }];
  }
  return [];
}

function eventTypeEvents(
  eventType: string,
  sessionId: string,
  payload: Record<string, unknown>,
  handle: MeshAgentRuntimeHandle | undefined
): MeshAgentOutputEvent[] {
  switch (eventType) {
    case 'message.delta': {
      const text = payload.text;
      return typeof text === 'string' && text.length > 0 ? [{ type: 'agent_message', payload: { text } }] : [];
    }
    case 'message.complete': {
      const text = typeof payload.text === 'string' ? payload.text : '';
      if (payload.status === 'error') {
        return [{ type: 'provider_error', payload: { message: text || 'Hermes provider error' } }];
      }
      return [{ type: 'agent_message', payload: compactObject({ text, final: true }) }];
    }
    case 'session.usage': {
      const parsed = hermesSessionUsagePayloadSchema.safeParse(payload);
      if (!parsed.success) return [];
      const usage = parsed.data.usage;
      return [
        {
          type: 'session_usage_updated',
          payload: meshAgentSessionUsageSchema.parse({
            total: usage.total,
            input: usage.input,
            output: usage.output,
            ...(usage.reasoning === undefined ? {} : { reasoningOutput: usage.reasoning }),
            ...(usage.context_used === undefined || usage.context_max === undefined
              ? {}
              : { context: { used: usage.context_used, window: usage.context_max } })
          })
        }
      ];
    }
    case 'approval.request': {
      // Hermes approvals are per-SESSION, not per-id — the session id alone would collide if a second
      // approval arrives before the first resolves (the host dedupes pending approvals by requestId), so
      // suffix a per-handle sequence number to keep concurrent requests distinct.
      const seq = handle ? (approvalSeqByHandle.get(handle) ?? 0) + 1 : 1;
      if (handle) approvalSeqByHandle.set(handle, seq);
      return [
        {
          type: 'approval_requested',
          payload: compactObject({
            requestId: `${sessionId}:${seq}`,
            kind: typeof payload.kind === 'string' ? payload.kind : 'approval',
            tool: payload.tool,
            command: payload.command,
            cwd: payload.cwd
          })
        }
      ];
    }
    case 'error':
      return [
        {
          type: 'provider_error',
          payload: { message: typeof payload.message === 'string' ? payload.message : 'Hermes provider error' }
        }
      ];
    default:
      return [];
  }
}

export function parseHermesFrame(frame: HermesFrame, handle?: MeshAgentRuntimeHandle): MeshAgentOutputEvent[] {
  if ('result' in frame || 'error' in frame) return responseEvents(frame, handle);
  if (frame.method !== 'event') return [];
  const params = recordValue(frame.params) ?? {};
  const eventType = params.type;
  const sessionId = params.session_id;
  if (typeof eventType !== 'string' || typeof sessionId !== 'string') return [];
  return eventTypeEvents(eventType, sessionId, recordValue(params.payload) ?? {}, handle);
}

export function parseHermesOutput(chunk: string, handle?: MeshAgentRuntimeHandle): MeshAgentOutputEvent[] {
  const events: MeshAgentOutputEvent[] = [];
  for (const rawLine of chunk.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) continue;
    const record = parseJsonObject(line);
    if (!record) continue;
    events.push(...parseHermesFrame(record as HermesFrame, handle));
  }
  return events;
}

export function sendHermesInput(handle: MeshAgentRuntimeHandle, input: string): void {
  if (!handle.gateway) throw new Error('MeshAgent session has no Hermes gateway input bridge');
  const sessionId = ephemeralSessionIds.get(handle);
  if (!sessionId) throw new Error('Hermes gateway session is not ready');
  const id = handle.nextRequestId?.() ?? Date.now();
  handle.pendingRequests?.set(id, 'turn');
  handle.gateway.send(jsonRpcRequest('prompt.submit', id, { session_id: sessionId, text: input }));
}

// Hermes streams `message.delta`/`message.complete`/`tool.*`/`approval.*` events only: the prompt it
// accepted is never sent back over the socket, so a live observer sees answers without their question
// until the session is re-read from Hermes' own stored transcript. This is that missing record, in the
// role-carrying shape the transcript uses, so both planes project the same user-message event.
export function echoHermesInput(input: string): string {
  const timestamp = Date.now();
  return `\n${JSON.stringify({
    id: `monad-echo-${timestamp}`,
    role: 'user',
    content: input,
    timestamp: new Date(timestamp).toISOString()
  })}\n`;
}

export function steerHermesInput(handle: MeshAgentRuntimeHandle, input: string): void {
  if (!handle.gateway) throw new Error('MeshAgent session has no Hermes gateway input bridge');
  const sessionId = ephemeralSessionIds.get(handle);
  if (!sessionId) throw new Error('Hermes gateway session is not ready');
  const id = handle.nextRequestId?.() ?? Date.now();
  handle.pendingRequests?.set(id, 'steer');
  handle.gateway.send(jsonRpcRequest('session.steer', id, { session_id: sessionId, text: input }));
}

export function interruptHermes(handle: MeshAgentRuntimeHandle): void {
  if (!handle.gateway) throw new Error('MeshAgent session has no Hermes gateway input bridge');
  const sessionId = ephemeralSessionIds.get(handle);
  if (!sessionId) throw new Error('Hermes gateway session is not ready');
  const id = handle.nextRequestId?.() ?? Date.now();
  handle.pendingRequests?.set(id, 'interrupt');
  handle.gateway.send(jsonRpcRequest('session.interrupt', id, { session_id: sessionId }));
}

export function resolveHermesApproval(handle: MeshAgentRuntimeHandle, resolution: MeshAgentApprovalResolution): void {
  if (!handle.gateway) throw new Error('MeshAgent session has no Hermes gateway approval bridge');
  const sessionId = ephemeralSessionIds.get(handle);
  if (!sessionId) throw new Error('Hermes gateway session is not ready');
  const id = handle.nextRequestId?.() ?? Date.now();
  // ExecApprovalDecision-equivalent here is `"deny"|"once"|"session"|"always"` (resolve_gateway_approval,
  // tools/approval.py) — our binary `allow` maps to the non-persistent grant.
  handle.pendingRequests?.set(id, `approvalRespond:${resolution.requestId}`);
  handle.gateway.send(
    jsonRpcRequest('approval.respond', id, { session_id: sessionId, choice: resolution.allow ? 'once' : 'deny' })
  );
}

export const hermesGatewayHooks: GatewayHooks = {
  initialize: hermesInitialize,
  parseOutput: parseHermesOutput,
  sendInput: sendHermesInput,
  echoInput: echoHermesInput,
  steer: steerHermesInput,
  interrupt: interruptHermes,
  resolveApproval: resolveHermesApproval
};
