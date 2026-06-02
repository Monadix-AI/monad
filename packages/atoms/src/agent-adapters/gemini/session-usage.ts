import type { MeshAgentProviderSessionUsageContext } from '@monad/sdk-atom';

import { homedir } from 'node:os';
import { join } from 'node:path';
import { meshAgentSessionUsageSchema } from '@monad/protocol';

import { readProviderEventFile } from '../event-files.ts';

interface GeminiSessionUsageDeps {
  readSession(context: MeshAgentProviderSessionUsageContext): string | null;
}

interface GeminiUsageRecord {
  id: string;
  input: number;
  output: number;
  cachedInput: number;
  reasoningOutput: number;
  total: number;
  model?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonnegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function usageRecord(value: unknown, fallbackId: string): GeminiUsageRecord | null {
  const message = record(value);
  if (message?.type !== 'gemini') return null;
  const tokens = record(message.tokens);
  const input = nonnegativeNumber(tokens?.input);
  const output = nonnegativeNumber(tokens?.output);
  if (input === undefined || output === undefined) return null;
  const reasoningOutput = nonnegativeNumber(tokens?.thoughts) ?? 0;
  return {
    id: typeof message.id === 'string' ? message.id : fallbackId,
    input,
    output,
    cachedInput: nonnegativeNumber(tokens?.cached) ?? 0,
    reasoningOutput,
    total: nonnegativeNumber(tokens?.total) ?? input + output + reasoningOutput,
    ...(typeof message.model === 'string' ? { model: message.model } : {})
  };
}

function contextWindow(model: string | undefined): number {
  return model?.includes('gemma-4') ? 256_000 : 1_048_576;
}

export function geminiSessionUsage(raw: string) {
  const messages = new Map<string, GeminiUsageRecord>();
  for (const [lineIndex, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim().startsWith('{')) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const usage = usageRecord(parsed, String(lineIndex));
    if (usage) messages.set(usage.id, usage);
  }
  const records = [...messages.values()];
  const latest = records.at(-1);
  if (!latest) return null;
  const totals = records.reduce(
    (sum, usage) => ({
      input: sum.input + usage.input,
      output: sum.output + usage.output,
      cachedInput: sum.cachedInput + usage.cachedInput,
      reasoningOutput: sum.reasoningOutput + usage.reasoningOutput,
      total: sum.total + usage.total
    }),
    { input: 0, output: 0, cachedInput: 0, reasoningOutput: 0, total: 0 }
  );
  return meshAgentSessionUsageSchema.parse({
    ...totals,
    context: { used: latest.input, window: contextWindow(latest.model) }
  });
}

export function createGeminiSessionUsageReader(deps: GeminiSessionUsageDeps) {
  return async function readGeminiSessionUsage(context: MeshAgentProviderSessionUsageContext) {
    const raw = deps.readSession(context);
    return raw ? geminiSessionUsage(raw) : null;
  };
}

export const readGeminiSessionUsage = createGeminiSessionUsageReader({
  readSession: (context) =>
    readProviderEventFile({
      roots: [join(homedir(), '.gemini', 'tmp'), join(homedir(), '.gemini', 'history')],
      providerSessionRef: context.providerSessionRef,
      extensions: ['.jsonl', '.json'],
      maxDepth: 8
    })
});
