import type { SessionId } from '@monad/protocol';
import type { ModelMessage } from '@monad/sdk-atom';
import type {
  Response as OAIResponse,
  ResponseCreateParamsBase,
  ResponseInput
} from 'openai/resources/responses/responses';

// ── Responses API wire types ──────────────────────────────────────────────────
// All openai SDK imports are type-only — erased at bundle time.

// Intersection narrows the SDK base to enforce the fields our handler requires.
export type ResponsesRequest = ResponseCreateParamsBase & {
  model: string;
  input: string | ResponseInput;
  stream?: boolean | null;
};

// OAIResponse covers every required field the OpenAI wire format mandates.
// x_monad is our vendor extension for session/agent/cost metadata.
export type ResponseObject = OAIResponse & {
  x_monad?: { session_id: string; agent_id?: string; cost_usd?: number };
};

export type StoredResponse = {
  response: ResponseObject;
  sessionId: SessionId;
  lastUsed: number;
  /** Message history for function-tool mode (no session used). */
  toolMessages?: ModelMessage[];
};
