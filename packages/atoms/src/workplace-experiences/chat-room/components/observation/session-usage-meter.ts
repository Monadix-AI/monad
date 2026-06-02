import type { MeshAgentSessionUsage } from '@monad/protocol';

export interface ObservationSessionUsageMeter {
  cachedInput?: number;
  contextMeterPercent: number;
  contextPercent: number;
  contextUsed: number;
  contextWindow: number;
  input: number;
  output: number;
  reasoningOutput?: number;
  total: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonnegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function observationSessionUsageMeter(
  usage: MeshAgentSessionUsage | null | undefined
): ObservationSessionUsageMeter | null {
  if (!usage) return null;
  const context = record(usage.context);
  const contextUsed = nonnegativeNumber(context?.used);
  const contextWindow = nonnegativeNumber(context?.window);
  if (contextUsed === undefined || contextWindow === undefined || contextWindow <= 0) return null;
  const contextPercent = Math.max(0, Math.round((contextUsed / contextWindow) * 100));
  const cachedInput = nonnegativeNumber(usage.cachedInput);
  const reasoningOutput = nonnegativeNumber(usage.reasoningOutput);
  return {
    contextMeterPercent: Math.min(100, contextPercent),
    contextPercent,
    contextUsed,
    contextWindow,
    input: usage.input,
    output: usage.output,
    total: usage.total,
    ...(cachedInput === undefined ? {} : { cachedInput }),
    ...(reasoningOutput === undefined ? {} : { reasoningOutput })
  };
}
