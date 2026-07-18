import type { ExternalAgentProviderHistoryContext, ExternalAgentProviderHistoryPageContext } from '@monad/sdk-atom';

import { homedir } from 'node:os';
import { join } from 'node:path';

import { readProviderHistoryFile } from '../history-files.ts';
import { recordValue } from './events.ts';

export function readCodexHistoryOutput(context: ExternalAgentProviderHistoryContext): string | null {
  return readProviderHistoryFile({
    roots: [join(homedir(), '.codex', 'sessions')],
    providerSessionRef: context.providerSessionRef,
    extensions: ['.jsonl'],
    limitBytes: context.limitBytes
  });
}

export function codexHistoryPageOutput(context: ExternalAgentProviderHistoryPageContext): string | null {
  const records = context.page.items.filter((item) => recordValue(item));
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
