// Mirrors the test harness mock in test/helpers.ts (kept in sync; the test helper may re-export from here).

import type { ModelRequest, ModelResult, ModelRouter } from '#/agent/index.ts';

/** The fixed reply the mock streams/returns. e2e asserts on this exact text. */
export const MOCK_REPLY = 'Hello from the mock model.';

/** Tokens the mock streams, in order. Concatenated they equal MOCK_REPLY. */
const MOCK_TOKENS = ['Hello', ' from', ' the', ' mock', ' model', '.'];

/** Build a deterministic mock model. `delayMs` spaces out stream tokens (resume tests). */
export function mockModel(tokens: string[] = MOCK_TOKENS, delayMs = 0): ModelRouter {
  return {
    async *stream(_req: ModelRequest) {
      for (const token of tokens) {
        if (delayMs) await Bun.sleep(delayMs);
        yield { type: 'text', token };
      }
    },
    async complete(_req: ModelRequest): Promise<ModelResult> {
      return { text: tokens.join(''), finishReason: 'stop' };
    }
  };
}
