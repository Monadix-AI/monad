import type { MeshAgentProviderEventContext, MeshAgentProviderEventPageContext } from '@monad/sdk-atom';

import { homedir } from 'node:os';
import { join } from 'node:path';

import { readProviderEventFile } from '../event-files.ts';
import { recordValue } from './app-server/events.ts';

export function readCodexEventOutput(context: MeshAgentProviderEventContext): string | null {
  return readProviderEventFile({
    roots: [join(homedir(), '.codex', 'sessions')],
    providerSessionRef: context.providerSessionRef,
    extensions: ['.jsonl']
  });
}

export function codexEventPageOutput(context: MeshAgentProviderEventPageContext): string | null {
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
