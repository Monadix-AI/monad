import type { MeshAgentObservationEvent } from '@monad/protocol';

import { observation, providerIsoTimestamp, recordValue, textValue } from '../../observation-projection.ts';

export function isCodexLogRecord(record: Record<string, unknown>): boolean {
  return record.level === 'ERROR' || record.level === 'WARN';
}

export function codexLogRecordEvents(
  id: string,
  record: Record<string, unknown>,
  recordIndex: number
): MeshAgentObservationEvent[] {
  const severity = record.level === 'ERROR' ? 'error' : record.level === 'WARN' ? 'warning' : undefined;
  const fields = recordValue(record.fields);
  const message = textValue(fields?.message);
  if (!severity || !message) return [];
  const detail = textValue(fields?.error);
  const target = textValue(record.target);
  const base = recordIndex === 0 ? id : `${id}:json:${recordIndex}`;
  return observation({
    id: `${base}:diagnostic`,
    role: 'system',
    text: message,
    source: 'codex-exec',
    providerEventType: 'diagnostic',
    diagnostic: {
      severity,
      message,
      ...(detail ? { detail } : {}),
      ...(target ? { target } : {})
    },
    createdAt: providerIsoTimestamp(textValue(record.timestamp)),
    raw: record
  });
}
