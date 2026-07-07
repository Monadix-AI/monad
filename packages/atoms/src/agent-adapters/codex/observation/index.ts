import type {
  NativeCliObservationJsonRecordEntry,
  NativeCliObservationProjector
} from '../../observation-projection.ts';

import {
  classifyObservationActivity,
  isStreamingObservationFragment,
  recordValue,
  textValue
} from '../../observation-projection.ts';
import {
  codexAppServerBatchRecordEvents,
  codexAppServerTurnsPageRecordEvents
} from './observation-app-server-items.ts';
import { codexAppServerRecordEvents } from './observation-app-server-notification.ts';
import { codexExecRecordEvents } from './observation-exec.ts';
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

function codexCompletedHistoryItemIds(entries: NativeCliObservationJsonRecordEntry[]): Set<string> {
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
  return (
    method === 'item/started' || method.endsWith('/delta') || method.endsWith('Delta') || method.endsWith('/progress')
  );
}

function codexHistoryEntries(entries: NativeCliObservationJsonRecordEntry[]): NativeCliObservationJsonRecordEntry[] {
  const completedItemIds = codexCompletedHistoryItemIds(entries);
  if (completedItemIds.size === 0) return entries;
  return entries.filter((entry) => !isCodexIntermediateHistoryRecord(entry.record, completedItemIds));
}

export const codexObservationProjection = {
  historyEntries: codexHistoryEntries,
  usageRecords: codexUsageRecordsFromRecord,
  messageGroup: codexObservationMessageGroupAdapter,
  classifyActivity: classifyObservationActivity,
  isStreamingFragment: isStreamingObservationFragment,
  recordProjectors: [
    {
      supports: isCodexObservationNotification,
      parse: ({ id, record, recordIndex }) =>
        isCodexObservationNotification(record) ? codexAppServerRecordEvents(id, record, recordIndex) : []
    },
    { parse: ({ id, record, recordIndex }) => codexAppServerBatchRecordEvents(id, record, recordIndex) },
    { parse: ({ id, record, recordIndex }) => codexAppServerTurnsPageRecordEvents(id, record, recordIndex) },
    { parse: ({ id, record, recordIndex }) => codexExecRecordEvents(id, record, recordIndex) }
  ]
} satisfies NativeCliObservationProjector;
