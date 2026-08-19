import type { MeshAgentObservationEvent, MeshAgentObservationTool } from '@monad/protocol';

import { recordValue, textValue } from '../shared/observation/observation-projection.ts';
import { parseStreamingJson } from '../shared/parsing/partial-json.ts';

/** Decode Qwen Code tool fields from its message/content-block transcript. */
export function qwenTranscriptTool(
  event: MeshAgentObservationEvent,
  kind: 'tool-call' | 'tool-result'
): MeshAgentObservationTool | undefined {
  const rawRecords = event.provenance.rawEvents
    .map((value) => recordValue(value))
    .filter((value): value is Record<string, unknown> => value !== undefined);
  const content = rawRecords.flatMap((record) => {
    const message = recordValue(record.message);
    return Array.isArray(message?.content) ? message.content : Array.isArray(record.content) ? record.content : [];
  });
  const parts = content
    .map((part) => recordValue(part))
    .filter((part): part is Record<string, unknown> => part !== undefined);
  const transcriptToolUse = parts.findLast((part) => part.type === 'tool_use');
  const toolResult =
    parts.find((part) => part.type === 'tool_result') ?? rawRecords.find((record) => record.type === 'tool_result');
  const streamToolUse = rawRecords
    .map((record) => recordValue(recordValue(record.event)?.content_block))
    .find((block) => block?.type === 'tool_use');
  const toolUse = transcriptToolUse ?? streamToolUse;
  const partialInputJson = rawRecords
    .map((record) => recordValue(recordValue(record.event)?.delta)?.partial_json)
    .filter((value): value is string => typeof value === 'string')
    .join('');
  const partialInput = partialInputJson ? parseStreamingJson(partialInputJson) : undefined;
  const input = transcriptToolUse?.input ?? partialInput ?? streamToolUse?.input;
  const name = textValue(toolUse?.name);
  const callId = textValue(toolUse?.id, toolResult?.tool_use_id, toolResult?.id);
  const tool: MeshAgentObservationTool = {
    ...(name ? { name } : {}),
    ...(callId ? { callId } : {}),
    ...(input === undefined ? {} : { input }),
    ...(kind === 'tool-result' && toolResult !== undefined
      ? {
          ...((toolResult.output ?? toolResult.result) === undefined
            ? {}
            : { output: toolResult.output ?? toolResult.result }),
          status: toolResult.is_error === true ? ('failed' as const) : ('completed' as const)
        }
      : {})
  };
  return Object.keys(tool).length > 0 ? tool : undefined;
}
