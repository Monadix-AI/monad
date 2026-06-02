import { RPC_ERRORS } from '@monad/protocol';

export type HandlerErrorKind =
  | 'not_found' // 404 HTTP / -32001 RPC
  | 'invalid' // 400 HTTP / -32602 RPC (INVALID_PARAMS)
  | 'conflict' // 409 HTTP / -32003 RPC
  | 'forbidden' // 403 HTTP / -32004 RPC
  | 'bad_gateway' // 502 HTTP / -32005 RPC
  | 'internal'; // 500 HTTP / -32603 RPC

export interface HandlerErrorMapping {
  /** HTTP status returned by the REST transport. */
  httpStatus: number;
  /** Machine-readable tag in the HTTP `{ error, code }` envelope. */
  httpCode: string;
  /** JSON-RPC error code returned by the NDJSON transports. */
  rpcCode: number;
}

/**
 * Single source of truth for how each HandlerError kind surfaces on every transport. Both the HTTP
 * onError handler and the JSON-RPC dispatcher read this map, so a kind maps to exactly one
 * status/code triple — the HTTP `code` and the RPC code can never drift apart per kind.
 */
export const HANDLER_ERROR_MAP = {
  not_found: { httpStatus: 404, httpCode: 'NOT_FOUND', rpcCode: -32001 },
  invalid: { httpStatus: 400, httpCode: 'VALIDATION', rpcCode: RPC_ERRORS.INVALID_PARAMS.code },
  conflict: { httpStatus: 409, httpCode: 'CONFLICT', rpcCode: -32003 },
  forbidden: { httpStatus: 403, httpCode: 'FORBIDDEN', rpcCode: -32004 },
  bad_gateway: { httpStatus: 502, httpCode: 'BAD_GATEWAY', rpcCode: -32005 },
  internal: { httpStatus: 500, httpCode: 'INTERNAL', rpcCode: RPC_ERRORS.INTERNAL_ERROR.code }
} as const satisfies Record<HandlerErrorKind, HandlerErrorMapping>;

export class HandlerError extends Error {
  constructor(
    readonly kind: HandlerErrorKind,
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = 'HandlerError';
  }
}
