// Lives here rather than @/capabilities/tools because — like delegate/vision/tts — it closes over
// a daemon-provided dependency (the ClarifyService ask function) rather than being a static
// built-in. Resolves with '' on timeout so the agent proceeds with best-effort judgement.

import type { Tool } from '#/capabilities/tools/types.ts';

import { z } from 'zod';

import { toolResult } from '#/capabilities/tools/types.ts';

/** Ask the user a question on a session; resolves with their answer ('' on timeout). */
export type ClarifyAsk = (sessionId: string, question: string, options?: string[]) => Promise<string>;

const clarifyInput = z.object({
  question: z.string().min(1).describe('The single clarifying question to ask the user'),
  options: z.array(z.string()).optional().describe('Optional suggested answers to present as choices')
});
type ClarifyInput = z.infer<typeof clarifyInput>;

export function createClarifyTool(ask: ClarifyAsk): Tool<ClarifyInput, { answer: string }> {
  return {
    name: 'clarify_ask',
    description:
      "Ask the user a single clarifying question and wait for their reply. Use when the request is genuinely ambiguous and a wrong guess would be costly — not for routine decisions you can make yourself. Optionally supply `options` to suggest choices. Returns the user's free-text answer (empty if they don't respond in time, in which case proceed with your best judgement).",
    scopes: [{ resource: 'clarify:ask' }],
    inputSchema: clarifyInput,
    run: async ({ question, options }, ctx) => {
      const answer = await ask(ctx.sessionId, question, options);
      return toolResult({ answer });
    }
  };
}

import type { ToolModule } from './contract.ts';
// Uniform module entry.
export const register: ToolModule<{ ask: ClarifyAsk }> = ({ ask }) => [createClarifyTool(ask)];
