import type { MeshAgentOutputEvent } from '@monad/sdk-atom';

import { compactObject, parseJsonObject } from '../adapter-shared.ts';

function itemEvents(recordType: string, value: unknown): MeshAgentOutputEvent[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const item = value as Record<string, unknown>;
  const itemType = item.type;
  if (itemType === 'agent_message' && typeof item.text === 'string') {
    return [{ type: 'agent_message', payload: { text: item.text } }];
  }
  if (recordType === 'item.started' && typeof itemType === 'string') {
    return [
      {
        type: 'tool_call',
        payload: compactObject({ callId: item.id, tool: itemType, input: item.command ?? item.arguments })
      }
    ];
  }
  if (recordType === 'item.completed' && typeof itemType === 'string') {
    return [
      {
        type: 'tool_result',
        payload: compactObject({
          callId: item.id,
          output: item.aggregated_output ?? item.result ?? item.output,
          exitCode: item.exit_code,
          status: item.status
        })
      }
    ];
  }
  return [];
}

function recordEvents(record: Record<string, unknown>): MeshAgentOutputEvent[] {
  const type = record.type;
  if (type === 'thread.started' && typeof record.thread_id === 'string') {
    return [{ type: 'session_ref', payload: { providerSessionRef: record.thread_id } }];
  }
  if (type === 'item.started' || type === 'item.completed') return itemEvents(type, record.item);
  if (type === 'turn.completed') return [{ type: 'agent_message', payload: { text: '', final: true } }];
  if (type === 'turn.failed' || type === 'error') {
    const error = record.error;
    const message =
      typeof error === 'string'
        ? error
        : error &&
            typeof error === 'object' &&
            !Array.isArray(error) &&
            typeof (error as { message?: unknown }).message === 'string'
          ? (error as { message: string }).message
          : 'Codex exec turn failed';
    return [{ type: 'provider_error', payload: { code: type, message } }];
  }
  if (type === 'result' && typeof record.result === 'string') {
    return [{ type: 'agent_message', payload: { text: record.result, final: true } }];
  }
  return [];
}

export function parseCodexExecJsonl(chunk: string): MeshAgentOutputEvent[] {
  const events: MeshAgentOutputEvent[] = [];
  for (const line of chunk.split(/\r?\n/)) {
    const record = parseJsonObject(line.trim());
    if (record) events.push(...recordEvents(record));
  }
  return events;
}
