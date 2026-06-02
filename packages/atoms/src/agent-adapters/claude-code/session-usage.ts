import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { MeshAgentProviderSessionUsageContext } from '@monad/sdk-atom';

import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { meshAgentSessionUsageSchema } from '@monad/protocol';

interface ClaudeSessionUsageDeps {
  getSessionMessages: typeof getSessionMessages;
}

interface ClaudeAssistantUsage {
  id: string;
  model: string;
  input: number;
  output: number;
  cacheCreationInput: number;
  cacheReadInput: number;
}

const CLAUDE_ONE_MILLION_CONTEXT_MODELS = new Set([
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-sonnet-4-6',
  'claude-sonnet-5'
]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonnegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function assistantUsage(message: SessionMessage): ClaudeAssistantUsage | null {
  if (message.type !== 'assistant') return null;
  const body = record(message.message);
  const usage = record(body?.usage);
  const id = body?.id;
  const model = body?.model;
  const input = nonnegativeNumber(usage?.input_tokens);
  const output = nonnegativeNumber(usage?.output_tokens);
  if (typeof id !== 'string' || typeof model !== 'string' || input === null || output === null) return null;
  return {
    id,
    model,
    input,
    output,
    cacheCreationInput: nonnegativeNumber(usage?.cache_creation_input_tokens) ?? 0,
    cacheReadInput: nonnegativeNumber(usage?.cache_read_input_tokens) ?? 0
  };
}

function contextWindow(model: string): number | undefined {
  if (model.endsWith('[1m]') || CLAUDE_ONE_MILLION_CONTEXT_MODELS.has(model)) return 1_000_000;
  return undefined;
}

export function claudeSessionUsage(messages: SessionMessage[]) {
  const unique = new Map<string, ClaudeAssistantUsage>();
  for (const message of messages) {
    const usage = assistantUsage(message);
    if (usage && !unique.has(usage.id)) unique.set(usage.id, usage);
  }
  const records = [...unique.values()];
  const latest = records.at(-1);
  if (!latest) return null;

  const totals = records.reduce(
    (sum, usage) => ({
      input: sum.input + usage.input + usage.cacheCreationInput + usage.cacheReadInput,
      output: sum.output + usage.output,
      cachedInput: sum.cachedInput + usage.cacheReadInput
    }),
    { input: 0, output: 0, cachedInput: 0 }
  );
  const window = contextWindow(latest.model);
  const contextUsed = latest.input + latest.cacheCreationInput + latest.cacheReadInput + latest.output;
  return meshAgentSessionUsageSchema.parse({
    total: totals.input + totals.output,
    input: totals.input,
    output: totals.output,
    cachedInput: totals.cachedInput,
    ...(window === undefined ? {} : { context: { used: contextUsed, window } })
  });
}

export function createClaudeSessionUsageReader(deps: ClaudeSessionUsageDeps) {
  return async function readClaudeSessionUsage(context: MeshAgentProviderSessionUsageContext) {
    const messages = await deps.getSessionMessages(context.providerSessionRef, {
      dir: context.workingPath,
      includeSystemMessages: true
    });
    return claudeSessionUsage(messages);
  };
}

export const readClaudeSessionUsage = createClaudeSessionUsageReader({ getSessionMessages });
