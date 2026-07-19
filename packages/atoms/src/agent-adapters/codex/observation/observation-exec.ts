import type { MeshAgentObservationEvent } from '@monad/protocol';

import { observation, permissionDenialEvents, textValue } from '../../observation-projection.ts';
import { codexResponseItem, isCodexObservationResponseItem } from './observation-response-item.ts';

export function codexExecRecordEvents(
  id: string,
  record: Record<string, unknown>,
  recordIndex: number
): MeshAgentObservationEvent[] {
  const type = record.type;
  const base = recordIndex === 0 ? id : `${id}:json:${recordIndex}`;
  if (type === 'result') {
    return [
      ...observation({
        id: `${base}:result`,
        role: 'agent',
        text: textValue(record.result, record.response, record.text),
        source: 'codex-exec',
        providerEventType: 'result',
        raw: record
      }),
      ...permissionDenialEvents(
        id,
        record.permission_denials,
        'codex-exec',
        recordIndex === 0 ? undefined : recordIndex
      )
    ];
  }
  if (type === 'item.completed' || type === 'item.started') {
    const item = record.item;
    if (isCodexObservationResponseItem(item)) {
      return codexResponseItem(id, item, recordIndex, 'codex-exec', record);
    }
  }
  if (type === 'event_msg') {
    const payload = record.payload;
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const p = payload as Record<string, unknown>;
      const text = p.type === 'agent_message' ? textValue(p.message) : undefined;
      return observation({
        id: `${id}:json:${recordIndex}:event-message`,
        role: 'agent',
        text,
        source: 'codex-exec',
        providerEventType: 'event_msg',
        raw: record
      });
    }
  }
  if (type === 'response_item') {
    const payload = record.payload;
    if (isCodexObservationResponseItem(payload)) {
      return codexResponseItem(id, payload, recordIndex, 'codex-exec', record);
    }
  }
  return [];
}
