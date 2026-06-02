import type { MeshAgentObservationEvent } from '@monad/protocol';
import type { MeshAgentObservationProjector } from '../observation-projection.ts';

import { classifyObservationActivity, isStreamingObservationFragment, observation } from '../observation-projection.ts';

export function antigravityRecordEvents(
  id: string,
  record: Record<string, unknown>,
  recordIndex: number
): MeshAgentObservationEvent[] {
  if (record.event === 'step_update') {
    const step =
      record.step_update && typeof record.step_update === 'object' && !Array.isArray(record.step_update)
        ? (record.step_update as Record<string, unknown>)
        : undefined;
    if (!step) return [];
    const stepType = typeof step.step_type === 'string' ? step.step_type : 'step_update';
    const text =
      typeof step.text_delta === 'string'
        ? step.text_delta
        : step.tool_output === undefined
          ? undefined
          : typeof step.tool_output === 'string'
            ? step.tool_output
            : JSON.stringify(step.tool_output);
    return observation({
      id: `${id}:json:${recordIndex}:step`,
      role: stepType.includes('tool') ? 'tool' : stepType === 'user_input' ? 'user' : 'agent',
      text,
      source: 'antigravity-cli',
      providerEventType: stepType,
      raw: record,
      preserveWhitespace: stepType === 'agent_response'
    });
  }
  if (record.event === 'result') {
    const result =
      record.result && typeof record.result === 'object' && !Array.isArray(record.result)
        ? (record.result as Record<string, unknown>)
        : undefined;
    const text =
      typeof result?.response === 'string' && result.response
        ? result.response
        : typeof result?.error === 'string'
          ? result.error
          : undefined;
    return observation({
      id: `${id}:json:${recordIndex}:result`,
      role: result?.status === 'SUCCESS' ? 'agent' : 'system',
      text,
      source: 'antigravity-cli',
      providerEventType: 'result',
      raw: record
    });
  }
  return [];
}

export const antigravityObservationProjection = {
  classifyActivity: classifyObservationActivity,
  isStreamingFragment: isStreamingObservationFragment,
  recordProjectors: [{ parse: ({ id, record, recordIndex }) => antigravityRecordEvents(id, record, recordIndex) }]
} satisfies MeshAgentObservationProjector;
