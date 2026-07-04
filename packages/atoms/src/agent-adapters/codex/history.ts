import type { NativeCliProviderHistoryContext, NativeCliProviderHistoryPageContext } from '@monad/sdk-atom';

import { homedir } from 'node:os';
import { join } from 'node:path';

import { readProviderHistoryFile } from '../history-files.ts';
import { recordValue, stringValue } from './events.ts';

export function readCodexHistoryOutput(context: NativeCliProviderHistoryContext): string | null {
  return readProviderHistoryFile({
    roots: [join(homedir(), '.codex', 'sessions')],
    providerSessionRef: context.providerSessionRef,
    extensions: ['.jsonl'],
    limitBytes: context.limitBytes
  });
}

export function codexHistoryPageOutput(context: NativeCliProviderHistoryPageContext): string | null {
  const records: Record<string, unknown>[] = [];
  for (const item of context.page.items) {
    const turn = recordValue(item);
    if (!turn) continue;
    const turnId = stringValue(turn.id);
    if (!turnId) continue;
    records.push({
      method: 'turn/started',
      params: {
        threadId: context.providerSessionRef,
        turnId,
        status: turn.status,
        startedAt: turn.startedAt
      }
    });
    const items = Array.isArray(turn.items) ? turn.items : [];
    for (const turnItem of items) {
      const record = recordValue(turnItem);
      if (!record) continue;
      records.push({
        method: 'item/completed',
        params: {
          threadId: context.providerSessionRef,
          turnId,
          item: record
        }
      });
    }
    records.push({
      method: 'turn/completed',
      params: {
        threadId: context.providerSessionRef,
        turnId,
        status: turn.status,
        completedAt: turn.completedAt,
        durationMs: turn.durationMs
      }
    });
  }
  if (records.length === 0) return null;
  return records.map((record) => JSON.stringify(record)).join('\n');
}

export function buildCodexInitialTurnsPage(): Record<string, unknown> {
  return {
    limit: 20,
    sortDirection: 'desc',
    itemsView: 'summary'
  };
}
