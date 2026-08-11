import type { MeshAgentObservationEvent } from '@monad/protocol';
import type {
  MeshAgentObservationJsonRecordEntry,
  MeshAgentObservationProjector
} from '../../observation-projection.ts';

import { contentHash } from '@monad/sdk-atom/agent-observation';

import {
  classifyObservationActivity,
  isStreamingObservationFragment,
  recordValue,
  textValue,
  toolCategoryByName
} from '../../observation-projection.ts';
import {
  codexAppServerBatchRecordEvents,
  codexAppServerTurnsPageRecordEvents
} from './observation-app-server-items.ts';
import {
  codexAppServerRecordEvents,
  codexLiveAppServerRecordEvents,
  isCodexLiveAppServerRecord
} from './observation-app-server-notification.ts';
import { codexExecRecordEvents } from './observation-exec.ts';
import { codexLogRecordEvents, isCodexLogRecord } from './observation-log.ts';
import { codexObservationMessageGroupAdapter } from './observation-message-group.ts';
import { codexUsageRecordsFromRecord } from './observation-usage.ts';

export type CodexObservationNotification = Record<string, unknown> & { method: string };

export function isCodexObservationNotification(
  record: Record<string, unknown>
): record is CodexObservationNotification {
  return typeof record.method === 'string';
}

function codexHistoryItemId(record: Record<string, unknown>): string | undefined {
  const params = recordValue(record.params);
  return textValue(params?.itemId, recordValue(params?.item)?.id);
}

function codexCompletedHistoryItemIds(entries: MeshAgentObservationJsonRecordEntry[]): Set<string> {
  const completed = new Set<string>();
  for (const entry of entries) {
    if (textValue(entry.record.method) !== 'item/completed') continue;
    const itemId = codexHistoryItemId(entry.record);
    if (itemId) completed.add(itemId);
  }
  return completed;
}

function isCodexIntermediateHistoryRecord(record: Record<string, unknown>, completedItemIds: Set<string>): boolean {
  const method = textValue(record.method);
  if (!method) return false;
  const itemId = codexHistoryItemId(record);
  if (!itemId || !completedItemIds.has(itemId)) return false;
  const params = recordValue(record.params);
  const item = recordValue(params?.item);
  if (textValue(item?.type) === 'reasoning' || method.includes('/reasoning/')) return false;
  return (
    method === 'item/started' || method.endsWith('/delta') || method.endsWith('Delta') || method.endsWith('/progress')
  );
}

function codexHistoryEntries(entries: MeshAgentObservationJsonRecordEntry[]): MeshAgentObservationJsonRecordEntry[] {
  const completedItemIds = codexCompletedHistoryItemIds(entries);
  if (completedItemIds.size === 0) return entries;
  return entries.filter((entry) => !isCodexIntermediateHistoryRecord(entry.record, completedItemIds));
}

function codexObservationIdentity(event: MeshAgentObservationEvent): string | undefined {
  const raw = recordValue(event.provenance.rawEvents[0]);
  const params = recordValue(raw?.params);
  return textValue(params?.turnId, recordValue(params?.turn)?.id);
}

function codexObservationCheckpoint(event: MeshAgentObservationEvent): string | undefined {
  const raw = recordValue(event.provenance.rawEvents[0]);
  return textValue(raw?.method) === 'turn/completed' ? codexObservationIdentity(event) : undefined;
}

function codexObservationDedupeIdentity(event: MeshAgentObservationEvent): string | undefined {
  if (event.providerEventType !== 'item/agentMessage' && event.providerEventType !== 'item/userMessage') {
    return undefined;
  }
  for (const rawEvent of event.provenance.rawEvents) {
    const raw = recordValue(rawEvent);
    const params = recordValue(raw?.params);
    const turnId = textValue(
      params?.turnId,
      recordValue(params?.turn)?.id,
      raw?.itemsView && raw?.status ? raw.id : undefined
    );
    if (turnId) return `turn:${turnId}:message:${event.role}:${contentHash(event.text)}`;
  }
  return undefined;
}

export const codexObservationProjection = {
  checkpoint: codexObservationCheckpoint,
  dedupeIdentity: codexObservationDedupeIdentity,
  identity: codexObservationIdentity,
  eventEntries: codexHistoryEntries,
  usageRecords: codexUsageRecordsFromRecord,
  messageGroup: codexObservationMessageGroupAdapter,
  classifyActivity: classifyObservationActivity,
  toolCategory: toolCategoryByName('shell', [
    'commandExecution',
    'command_execution',
    'execCommand',
    'exec_command',
    'shell',
    'shell_exec',
    'bash'
  ]),
  isStreamingFragment: isStreamingObservationFragment,
  recordProjectors: [
    {
      supports: isCodexLogRecord,
      parse: ({ id, record, recordIndex }) => codexLogRecordEvents(id, record, recordIndex)
    },
    {
      supports: isCodexObservationNotification,
      parse: ({ id, record, recordIndex }) =>
        isCodexObservationNotification(record) ? codexAppServerRecordEvents(id, record, recordIndex) : []
    },
    {
      supports: isCodexLiveAppServerRecord,
      parse: ({ id, record, recordIndex }) =>
        isCodexLiveAppServerRecord(record) ? codexLiveAppServerRecordEvents(id, record, recordIndex) : []
    },
    { parse: ({ id, record, recordIndex }) => codexAppServerBatchRecordEvents(id, record, recordIndex) },
    { parse: ({ id, record, recordIndex }) => codexAppServerTurnsPageRecordEvents(id, record, recordIndex) },
    { parse: ({ id, record, recordIndex }) => codexExecRecordEvents(id, record, recordIndex) }
  ]
} satisfies MeshAgentObservationProjector;
