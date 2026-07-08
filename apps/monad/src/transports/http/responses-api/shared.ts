import { timingSafeEqual } from 'node:crypto';

import { HANDLER_ERROR_MAP, HandlerError } from '#/handlers/handler-error.ts';
import { buildSessionOrigin } from '#/handlers/session/origin.ts';

// ── constants ─────────────────────────────────────────────────────────────────

export const RESPONSE_TTL_MS = 24 * 60 * 60 * 1000;
export const RESPONSE_GC_INTERVAL_MS = 30 * 60 * 1000;
export const MAX_STREAMING_BACKLOG = 512;
export const MAX_STORED_RESPONSES = 10_000;

export const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization, x-monad-agent-id, x-monad-session-id',
  'access-control-max-age': '86400'
};

export const SESSION_ORIGIN = buildSessionOrigin({ transport: 'http', surface: 'api', client: 'responses-api' });

// ── helpers ───────────────────────────────────────────────────────────────────

export function errorResponse(message: string, status = 400, type = 'invalid_request_error', code?: string): Response {
  return new Response(JSON.stringify({ error: { message, type, ...(code ? { code } : {}) } }), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS }
  });
}

export function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', ...CORS_HEADERS }
  });
}

export function checkToken(request: Request, token: string): boolean {
  const header = request.headers.get('authorization') ?? '';
  const expected = `Bearer ${token}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  const len = Math.max(a.length, b.length, 1);
  const pa = Buffer.concat([a, Buffer.alloc(len - a.length)]);
  const pb = Buffer.concat([b, Buffer.alloc(len - b.length)]);
  return timingSafeEqual(pa, pb) && a.length === b.length;
}

export function handlerErrorToResponse(err: unknown): Response {
  if (err instanceof HandlerError) {
    const { httpStatus } = HANDLER_ERROR_MAP[err.kind];
    return errorResponse(err.message, httpStatus, 'api_error', err.kind);
  }
  throw err;
}

export function sseFrame(eventType: string, data: unknown, encoder: TextEncoder): Uint8Array {
  return encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
}
