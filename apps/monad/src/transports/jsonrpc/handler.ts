import type { HostInteractionService } from '#/interactions/service.ts';
import type { ConnectionState } from '#/transports/jsonrpc/connection.ts';
import type { Push, RpcContext } from '#/transports/jsonrpc/methods.ts';

import { createLogger, formatTransportCall } from '@monad/logger';
import {
  isRpcMethod,
  jsonRpcRequestEnvelopeSchema,
  jsonRpcRequestIdEnvelopeSchema,
  RPC_ERRORS,
  RPC_METHOD_PARAMS
} from '@monad/protocol';

import { createDaemonHandlers, HandlerError } from '#/handlers/daemon-handlers/index.ts';
import { HANDLER_ERROR_MAP } from '#/handlers/handler-error.ts';
import { consumeToken } from '#/transports/jsonrpc/connection.ts';
import { RPC_HANDLERS } from '#/transports/jsonrpc/methods.ts';

const log = createLogger('transport:rpc');

function logRpcCall(transport: string, id: unknown, method: string, durationMs: number, err?: unknown): void {
  const record = { transport, id, method, durationMs, ...(err ? { err } : {}) };
  if (err) {
    log.error(record, formatTransportCall(record));
    return;
  }
  // trace is almost always disabled; skip the formatTransportCall allocation unless it's enabled.
  if (log.isLevelEnabled('trace')) log.trace(record, formatTransportCall(record));
}

/**
 * Handle one raw JSON-RPC message. Shared verbatim by all three NDJSON transports
 * (WebSocket frame, Unix-socket line, stdio line) so they validate and dispatch
 * identically.
 *
 * @param raw   - A single JSON-RPC request string (one WS frame or one NDJSON line).
 * @param state - Per-connection mutable subscription registry.
 * @param handlers - Transport-agnostic business logic.
 * @param push  - Transport-specific write-back; called for responses and notifications.
 */
export async function handleRpcMessage(
  raw: string,
  state: ConnectionState,
  handlers: ReturnType<typeof createDaemonHandlers>,
  push: Push,
  transport = 'rpc',
  options: { interactions?: HostInteractionService } = {}
): Promise<void> {
  let json: unknown;

  try {
    json = JSON.parse(raw);
  } catch {
    push({ jsonrpc: '2.0', id: null, error: RPC_ERRORS.PARSE_ERROR });
    return;
  }

  const envelope = jsonRpcRequestEnvelopeSchema.safeParse(json);
  if (!envelope.success) {
    const idEnvelope = jsonRpcRequestIdEnvelopeSchema.safeParse(json);
    push({
      jsonrpc: '2.0',
      id: idEnvelope.success ? (idEnvelope.data.id ?? null) : null,
      error: RPC_ERRORS.INVALID_REQUEST
    });
    return;
  }
  const req = envelope.data;

  // JSON-RPC 2.0 notification: id absent → dispatch and return, no reply.
  const isNotification = req.id == null;
  const id = req.id ?? null;
  const method = req.method;

  // Per-connection rate limit (browser-facing WS only). Reject cheaply before any
  // dispatch; a flooding client is throttled while steady-state traffic flows.
  if (state.rateLimiter && !consumeToken(state.rateLimiter)) {
    if (!isNotification) push({ jsonrpc: '2.0', id, error: RPC_ERRORS.RATE_LIMITED });
    return;
  }

  if (!isRpcMethod(method)) {
    push({ jsonrpc: '2.0', id, error: RPC_ERRORS.METHOD_NOT_FOUND });
    return;
  }

  // Schema-first: every transport parses params against the wire contract; loose
  // requests fail here with field-level detail rather than reaching the handlers.
  const parsed = RPC_METHOD_PARAMS[method].safeParse(req.params ?? {});
  if (!parsed.success) {
    push({
      jsonrpc: '2.0',
      id,
      error: {
        ...RPC_ERRORS.INVALID_PARAMS,
        data: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
      }
    });
    return;
  }

  const t0 = performance.now();
  try {
    // Single cast at the dispatch boundary: `method` and `parsed.data` are correlated
    // at runtime but TS can't track the relation across the dynamic index. params are
    // already schema-valid, so the handler receives exactly what it expects.
    const handler = RPC_HANDLERS[method] as (
      p: unknown,
      d: ReturnType<typeof createDaemonHandlers>,
      ctx: RpcContext
    ) => Promise<unknown>;
    const result = await handler(parsed.data, handlers, { state, push, interactions: options.interactions });
    logRpcCall(transport, id, method, Math.round(performance.now() - t0));
    if (!isNotification) push({ jsonrpc: '2.0', id, result });
  } catch (err) {
    logRpcCall(transport, id, method, Math.round(performance.now() - t0), err);
    // Notifications MUST NOT receive error replies either (JSON-RPC 2.0 §4).
    if (isNotification) return;
    const code = err instanceof HandlerError ? HANDLER_ERROR_MAP[err.kind].rpcCode : RPC_ERRORS.INTERNAL_ERROR.code;
    push({
      jsonrpc: '2.0',
      id,
      error: { code, message: err instanceof Error ? err.message : 'Internal error' }
    });
  }
}
