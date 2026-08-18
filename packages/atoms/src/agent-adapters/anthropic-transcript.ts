import type { MeshAgentObservationEvent, MeshAgentObservationTool } from '@monad/protocol';

import { recordValue, textValue } from './observation-projection.ts';
import { parseStreamingJson } from './partial-json.ts';

/** The Anthropic message/stream wire shape — `message.content` parts plus `content_block_*` stream
 *  events. Several providers speak it verbatim (Claude Code, Qwen Code), so the decode lives here
 *  rather than in any one of their adapters or in the provider-agnostic neutral projection. Reads
 *  the whole merged raw run because a streamed tool input only exists as `partial_json` fragments
 *  spread across the events that were merged into one. */
export function anthropicTranscriptTool(
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
    // No `output`: the adapter's projected `text` already flattens the result content, and the
    // neutral projection falls back to it. Declaring the raw parts here would change what renders.
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
