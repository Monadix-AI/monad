import type { NativeCliObservationProjector } from '../../observation-projection.ts';

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

export const codexObservationProjection = {
  usageRecords: codexUsageRecordsFromRecord,
  messageGroup: codexObservationMessageGroupAdapter,
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
