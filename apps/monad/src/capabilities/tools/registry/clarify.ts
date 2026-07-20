// Lives here rather than @/capabilities/tools because — like delegate/vision/tts — it closes over
// a daemon-provided dependency (the ClarifyService ask function) rather than being a static
// built-in. Resolves with '' on timeout so the agent proceeds with best-effort judgement.

import type { Tool } from '#/capabilities/tools/types.ts';

import { z } from 'zod';

import { toolResult } from '#/capabilities/tools/types.ts';

interface ClarifyToolRequest {
  question: string;
  options?: string[];
  autoResolutionMs?: number;
}

/** Ask the user a question on a session; resolves with their answer ('' on auto-resolution). */
export type ClarifyAsk = (sessionId: string, request: ClarifyToolRequest) => Promise<string>;

const clarifyInput = z.object({
  question: z.string().min(1).describe('The single clarifying question to ask the user'),
  options: z.array(z.string()).optional().describe('Optional suggested answers to present as choices'),
  autoResolutionMs: z
    .number()
    .int()
    .min(60_000)
    .max(240_000)
    .optional()
    .describe('Optional 1-4 minute wait for useful but non-blocking context. Omit when a human answer is required.')
});
type ClarifyInput = z.infer<typeof clarifyInput>;

export function createClarifyTool(ask: ClarifyAsk): Tool<ClarifyInput, { answer: string }> {
  return {
    name: 'clarify_ask',
    description:
      "Ask the user a single clarifying question and wait for their reply. Omit `autoResolutionMs` when proceeding without a human answer would be unsafe or violate the user's intent. Set it to 60000-240000 only for useful but non-blocking context; expiry returns an empty answer so you can proceed with best judgement.",
    scopes: [{ resource: 'clarify:ask' }],
    inputSchema: clarifyInput,
    run: async ({ question, options, autoResolutionMs }, ctx) => {
      const answer = await ask(ctx.sessionId, { question, options, autoResolutionMs });
      return toolResult({ answer });
    }
  };
}

import type { ToolModule } from './contract.ts';
// Uniform module entry.
export const register: ToolModule<{ ask: ClarifyAsk }> = ({ ask }) => [createClarifyTool(ask)];
