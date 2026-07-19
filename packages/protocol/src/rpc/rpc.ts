import type { Event } from '../domain.ts';
import type { TranscriptTargetId } from '../ids.ts';
import type { InteractionEvent } from '../interaction.ts';
import type { MessageGenerationFrame } from './control.ts';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

/** Server-push notification — no `id` field (fire-and-forget). */
export type JsonRpcNotification =
  | {
      jsonrpc: '2.0';
      method: 'sessions.event';
      params: { sessionId: TranscriptTargetId; event: Event };
    }
  | {
      jsonrpc: '2.0';
      method: 'interactions.event';
      params: { event: InteractionEvent };
    }
  | {
      jsonrpc: '2.0';
      method: 'session.messageGeneration.event';
      params: { sessionId: TranscriptTargetId; messageId: string; frame: MessageGenerationFrame };
    };

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export const RPC_ERRORS = {
  PARSE_ERROR: { code: -32700, message: 'Parse error' },
  INVALID_REQUEST: { code: -32600, message: 'Invalid request' },
  METHOD_NOT_FOUND: { code: -32601, message: 'Method not found' },
  INVALID_PARAMS: { code: -32602, message: 'Invalid params' },
  INTERNAL_ERROR: { code: -32603, message: 'Internal error' },
  RATE_LIMITED: { code: -32029, message: 'Rate limit exceeded' } // implementation-defined range (-32000..-32099)
} as const;

// `RpcMethod` and the method→params schema registry live in ./rpc-methods.ts.
