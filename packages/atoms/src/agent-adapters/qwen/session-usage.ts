import type { MeshAgentProviderSessionUsageContext } from '@monad/sdk-atom';

import { homedir } from 'node:os';
import { join } from 'node:path';
import { meshAgentSessionUsageSchema } from '@monad/protocol';

import { readProviderEventFile } from '../event-files.ts';

interface QwenSessionUsageDeps {
  readSession(context: MeshAgentProviderSessionUsageContext): string | null;
}

interface QwenUsageRecord {
  id: string;
  input: number;
  output: number;
  cachedInput: number;
  reasoningOutput: number;
  total: number;
  contextWindow?: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonnegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function currentChatRecord(value: Record<string, unknown>, fallbackId: string): QwenUsageRecord | null {
  if (value.type !== 'assistant') return null;
  const usage = record(value.usageMetadata);
  const input = nonnegativeNumber(usage?.promptTokenCount);
  const output = nonnegativeNumber(usage?.candidatesTokenCount);
  if (input === undefined || output === undefined) return null;
  const reasoningOutput = nonnegativeNumber(usage?.thoughtsTokenCount) ?? 0;
  return {
    id: typeof value.uuid === 'string' ? value.uuid : fallbackId,
    input,
    output,
    cachedInput: nonnegativeNumber(usage?.cachedContentTokenCount) ?? 0,
    reasoningOutput,
    total: nonnegativeNumber(usage?.totalTokenCount) ?? input + output + reasoningOutput,
    contextWindow: nonnegativeNumber(value.contextWindowSize)
  };
}

function usageFromRecords(records: QwenUsageRecord[]) {
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
  const window = latest.contextWindow;
  return meshAgentSessionUsageSchema.parse({
    ...totals,
    ...(window ? { context: { used: latest.input, window } } : {})
  });
}

export function qwenSessionUsage(raw: string) {
  const current = new Map<string, QwenUsageRecord>();
  for (const [lineIndex, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim().startsWith('{')) continue;
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const currentUsage = currentChatRecord(value, String(lineIndex));
    if (currentUsage) current.set(currentUsage.id, currentUsage);
  }
  return usageFromRecords([...current.values()]);
}

export function createQwenSessionUsageReader(deps: QwenSessionUsageDeps) {
  return async function readQwenSessionUsage(context: MeshAgentProviderSessionUsageContext) {
    const raw = deps.readSession(context);
    return raw ? qwenSessionUsage(raw) : null;
  };
}

export const readQwenSessionUsage = createQwenSessionUsageReader({
  readSession: (context) =>
    readProviderEventFile({
      roots: [join(homedir(), '.qwen')],
      providerSessionRef: context.providerSessionRef,
      extensions: ['.jsonl', '.json'],
      maxDepth: 8
    })
});
