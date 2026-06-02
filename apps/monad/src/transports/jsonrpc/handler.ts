import type { JsonRpcError, PublicErrorDescriptor } from '@monad/protocol';
import type { ConnectionState } from '#/transports/jsonrpc/connection.ts';
import type { Push, RpcContext } from '#/transports/jsonrpc/methods.ts';

import { createLogger, formatTransportCall } from '@monad/logger';
import {
  isRpcMethod,
  jsonRpcRequestEnvelopeSchema,
  jsonRpcRequestIdEnvelopeSchema,
  publicErrorDescriptorSchema,
  RPC_ERRORS,
  RPC_METHOD_PARAMS
} from '@monad/protocol';

import { createDaemonHandlers, HandlerError } from '#/handlers/daemon-handlers/index.ts';
import { HANDLER_ERROR_MAP } from '#/handlers/handler-error.ts';
import { consumeToken } from '#/transports/jsonrpc/connection.ts';
import { RPC_HANDLERS } from '#/transports/jsonrpc/methods.ts';
import { createRequestCorrelationId, mapPublicError } from '#/transports/public-error.ts';

const log = createLogger('transport:rpc');

function rpcError(
  base: { code: number; message: string },
  code: string,
  retryable: boolean,
  details?: PublicErrorDescriptor['details']
): JsonRpcError {
  return {
    ...base,
    data: publicErrorDescriptorSchema.parse({
      code,
      message: base.message,
      retryable,
      requestId: createRequestCorrelationId(),
      ...(details ? { details } : {})
    })
  };
}

function validationDetails(issues: Array<{ path: PropertyKey[]; message: string }>): PublicErrorDescriptor['details'] {
  return {
    issues: issues.slice(0, 16).map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'params';
      return `${path}: ${issue.message}`.slice(0, 512);
    })
  };
}

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
  transport = 'rpc'
): Promise<void> {
  let json: unknown;

  try {
    json = JSON.parse(raw);
  } catch {
    push({ jsonrpc: '2.0', id: null, error: rpcError(RPC_ERRORS.PARSE_ERROR, 'PARSE_ERROR', false) });
    return;
  }

  const envelope = jsonRpcRequestEnvelopeSchema.safeParse(json);
  if (!envelope.success) {
    const idEnvelope = jsonRpcRequestIdEnvelopeSchema.safeParse(json);
    push({
      jsonrpc: '2.0',
      id: idEnvelope.success ? (idEnvelope.data.id ?? null) : null,
      error: rpcError(RPC_ERRORS.INVALID_REQUEST, 'INVALID_REQUEST', false)
    });
    return;
  }
  const req = envelope.data;

  // JSON-RPC 2.0 notification: id absent → dispatch and return, no reply.
  const hasId = Object.hasOwn(req, 'id');
  const isNotification = !hasId;
  const id = hasId ? (req.id ?? null) : null;
  const method = req.method;

  // Per-connection rate limit (browser-facing WS only). Reject cheaply before any
  // dispatch; a flooding client is throttled while steady-state traffic flows.
  if (state.rateLimiter && !consumeToken(state.rateLimiter)) {
    if (!isNotification) {
      push({ jsonrpc: '2.0', id, error: rpcError(RPC_ERRORS.RATE_LIMITED, 'RATE_LIMITED', true) });
    }
    return;
  }

  if (!isRpcMethod(method)) {
    if (!isNotification) {
      push({ jsonrpc: '2.0', id, error: rpcError(RPC_ERRORS.METHOD_NOT_FOUND, 'METHOD_NOT_FOUND', false) });
    }
    return;
  }

  // Schema-first: every transport parses params against the wire contract; loose
  // requests fail here with field-level detail rather than reaching the handlers.
  const parsed = RPC_METHOD_PARAMS[method].safeParse(req.params ?? {});
  if (!parsed.success) {
    if (!isNotification) {
      push({
        jsonrpc: '2.0',
        id,
        error: rpcError(RPC_ERRORS.INVALID_PARAMS, 'VALIDATION', false, validationDetails(parsed.error.issues))
      });
    }
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
    const result = await handler(parsed.data, handlers, { state, push, interactions: handlers.interactions });
    logRpcCall(transport, id, method, Math.round(performance.now() - t0));
    if (!isNotification) push({ jsonrpc: '2.0', id, result });
  } catch (err) {
    logRpcCall(transport, id, method, Math.round(performance.now() - t0), err);
    // Notifications MUST NOT receive error replies either (JSON-RPC 2.0 §4).
    if (isNotification) return;
    if (err instanceof HandlerError) {
      const mapped = mapPublicError(err, createRequestCorrelationId());
      push({
        jsonrpc: '2.0',
        id,
        error: {
          code: HANDLER_ERROR_MAP[err.kind].rpcCode,
          message: mapped.descriptor.message,
          data: mapped.descriptor
        }
      });
      return;
    }
    const mapped = mapPublicError(err, createRequestCorrelationId());
    push({
      jsonrpc: '2.0',
      id,
      error: { ...RPC_ERRORS.INTERNAL_ERROR, data: mapped.descriptor }
    });
  }
}
