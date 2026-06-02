export type JsonRpcId = string | number;

/** Frame a JSON-RPC request (method + id + params) as a newline-delimited stdio line. */
export function jsonRpcRequest(method: string, id: JsonRpcId, params: Record<string, unknown>): string {
  return `${JSON.stringify({ method, id, params })}\n`;
}

/** Frame a JSON-RPC notification (method + params, no id) as a newline-delimited stdio line. */
export function jsonRpcNotification(method: string, params: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ method, params })}\n`;
}

/** Frame a successful JSON-RPC response as a newline-delimited stdio line. */
export function jsonRpcResponse(id: JsonRpcId, result: Record<string, unknown>): string {
  return `${JSON.stringify({ id, result })}\n`;
}

/** Frame a JSON-RPC error response as a newline-delimited stdio line. */
export function jsonRpcErrorResponse(id: JsonRpcId, code: number, message: string): string {
  return `${JSON.stringify({ id, error: { code, message } })}\n`;
}

/**
 * Preserve the original JSON-RPC id type when responding to a server-initiated request. Ids often
 * arrive numeric but get stringified as they cross the event/transport boundary; echoing the string
 * back would break the server's numeric-id correlation. Recover the verbatim id from the request
 * record when present, else fall back to the (possibly stringified) id.
 */
export function jsonRpcResponseId(raw: unknown, fallback: JsonRpcId): JsonRpcId {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return fallback;
}
