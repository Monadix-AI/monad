import type { MeshAgentObservationEvent } from '@monad/protocol';
import type { MeshAgentObservationProjector, ObservationRole } from '../observation-projection.ts';

import {
  classifyObservationActivity,
  compactJson,
  isStreamingObservationFragment,
  observation,
  textValue
} from '../observation-projection.ts';

function roleFromHermesMessage(record: Record<string, unknown>): ObservationRole {
  const role = textValue(record.role)?.toLowerCase();
  if (role === 'user') return 'user';
  if (role === 'system') return 'system';
  if (role === 'tool' || role === 'tool_result' || role === 'toolresult') return 'tool';
  return 'agent';
}

function textFromContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((part) => {
      if (!part || typeof part !== 'object' || Array.isArray(part)) return '';
      const item = part as Record<string, unknown>;
      if (item.type === 'text' && typeof item.text === 'string') return item.text;
      return '';
    })
    .join('');
  return text.trim() ? text : undefined;
}

function toolCallEvents(id: string, record: Record<string, unknown>, recordIndex: number): MeshAgentObservationEvent[] {
  const calls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
  return calls.flatMap((call, callIndex) => {
    if (!call || typeof call !== 'object' || Array.isArray(call)) return [];
    const item = call as Record<string, unknown>;
    const fn = item.function && typeof item.function === 'object' ? (item.function as Record<string, unknown>) : {};
    const name = textValue(item.name, item.tool_name, fn.name) ?? 'tool';
    const args = item.input ?? item.args ?? item.arguments ?? fn.arguments;
    const argsText = args === undefined ? '' : ` ${compactJson(args) ?? String(args)}`;
    return observation({
      id: `${id}:json:${recordIndex}:tool-call:${callIndex}`,
      role: 'tool',
      text: `Tool call ${name}${argsText}`,
      source: 'unknown',
      providerEventType: 'tool_call',
      raw: record
    });
  });
}

export function hermesRecordEvents(
  id: string,
  record: Record<string, unknown>,
  recordIndex: number
): MeshAgentObservationEvent[] {
  if (typeof record.role !== 'string') return [];

  const contentText =
    textFromContent(record.content) ??
    textValue(record.text, record.reasoning_content, record.reasoning, record.tool_name);
  const content = observation({
    id: `${id}:json:${recordIndex}:message`,
    role: roleFromHermesMessage(record),
    text: contentText,
    source: 'unknown',
    providerEventType: record.role === 'tool' ? 'tool_result' : 'message',
    raw: record
  });
  return [...content, ...toolCallEvents(id, record, recordIndex)];
}

export const hermesObservationProjection = {
  classifyActivity: classifyObservationActivity,
  isStreamingFragment: isStreamingObservationFragment,
  recordProjectors: [{ parse: ({ id, record, recordIndex }) => hermesRecordEvents(id, record, recordIndex) }]
} satisfies MeshAgentObservationProjector;
