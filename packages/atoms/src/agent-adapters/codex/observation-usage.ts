import type { NativeCliUsageRecord } from '@monad/protocol';

import { numberValue, recordValue, textValue } from '../observation-projection.ts';

function tokenUsageRow(id: string, tokens: unknown, contextWindow: unknown): NativeCliUsageRecord | undefined {
  const totalTokens = numberValue(tokens);
  const window = numberValue(contextWindow);
  if (totalTokens === undefined || window === undefined || window <= 0) return undefined;
  return {
    name: id,
    current: totalTokens,
    max: window
  };
}

function resetIso(value: unknown): string | undefined {
  const ms = numberValue(value);
  if (ms === undefined) return undefined;
  const timestampMs = ms < 10_000_000_000 ? ms * 1000 : ms;
  return new Date(timestampMs).toISOString();
}

function usageRecord(id: string, value: unknown): NativeCliUsageRecord | undefined {
  const record = recordValue(value);
  if (!record) return undefined;
  const used = numberValue(record.usedPercent, record.utilization, record.used_percent);
  if (used === undefined) return undefined;
  return {
    name: id,
    current: Math.max(0, Math.min(100, 100 - used)),
    max: 100,
    resetAt: resetIso(record.resetsAt ?? record.resets_at)
  };
}

export function codexUsageRecordsFromRecord(record: Record<string, unknown>): NativeCliUsageRecord[] {
  const method = textValue(record.method);
  if (method === 'thread/tokenUsage/updated') {
    const params = recordValue(record.params);
    const tokenUsage = recordValue(params?.tokenUsage);
    const last = recordValue(tokenUsage?.last);
    const total = recordValue(tokenUsage?.total);
    const contextWindow = tokenUsage?.modelContextWindow;
    return [
      tokenUsageRow('last_turn', last?.totalTokens, contextWindow),
      tokenUsageRow('thread_total', total?.totalTokens, contextWindow)
    ].filter((row): row is NativeCliUsageRecord => !!row);
  }
  if (method === 'account/rateLimits/updated') {
    const params = recordValue(record.params);
    const limits = recordValue(params?.rateLimits ?? params?.rate_limits);
    return limits
      ? Object.entries(limits)
          .map(([id, value]) => usageRecord(id, value))
          .filter((row): row is NativeCliUsageRecord => !!row)
      : [];
  }
  return [];
}
