import type { MeshAgentOutputEvent } from '@monad/sdk-atom';

import { z } from 'zod';

import { compactObject } from '../shared/adapter-shared.ts';

const antigravityUsageSchema = z
  .object({
    input_tokens: z.number().finite().nonnegative(),
    output_tokens: z.number().finite().nonnegative(),
    thinking_tokens: z.number().finite().nonnegative(),
    cache_read_tokens: z.number().finite().nonnegative(),
    total_tokens: z.number().finite().nonnegative()
  })
  .catchall(z.unknown());

export const antigravityInitEventSchema = z
  .object({
    event: z.literal('init'),
    conversation_id: z.string(),
    init: z
      .object({
        cwd: z.string().optional(),
        permission_mode: z.string().optional(),
        tools: z.array(z.string()).optional()
      })
      .catchall(z.unknown())
  })
  .catchall(z.unknown());

export const antigravityStepUpdateEventSchema = z
  .object({
    event: z.literal('step_update'),
    step_update: z
      .object({
        conversation_id: z.string().optional(),
        step_index: z.number().int().nonnegative(),
        state: z.string(),
        step_type: z.string(),
        text_delta: z.string().optional(),
        tool_name: z.string().optional(),
        tool_input: z.unknown().optional(),
        tool_output: z.unknown().optional(),
        usage: antigravityUsageSchema.optional()
      })
      .catchall(z.unknown())
  })
  .catchall(z.unknown());

export const antigravityResultEventSchema = z
  .object({
    event: z.literal('result'),
    result: z
      .object({
        conversation_id: z.string(),
        status: z.string(),
        response: z.string(),
        error: z.string().optional(),
        usage: antigravityUsageSchema
      })
      .catchall(z.unknown())
  })
  .catchall(z.unknown());

export const antigravityStreamJsonEventSchema = z.discriminatedUnion('event', [
  antigravityInitEventSchema,
  antigravityStepUpdateEventSchema,
  antigravityResultEventSchema
]);

export type AntigravityStreamJsonEvent = z.infer<typeof antigravityStreamJsonEventSchema>;

function usageEvent(usage: z.infer<typeof antigravityUsageSchema>): MeshAgentOutputEvent {
  return {
    type: 'session_usage_updated',
    payload: {
      total: usage.total_tokens,
      input: usage.input_tokens,
      output: usage.output_tokens,
      thinkingOutput: usage.thinking_tokens,
      cachedInput: usage.cache_read_tokens
    }
  };
}

function stepEvents(event: z.infer<typeof antigravityStepUpdateEventSchema>): MeshAgentOutputEvent[] {
  const step = event.step_update;
  const events: MeshAgentOutputEvent[] = [];
  if (step.step_type === 'agent_response' && step.text_delta) {
    events.push({ type: 'agent_message', payload: { text: step.text_delta } });
  } else if (step.step_type.includes('tool') && step.state === 'ACTIVE') {
    events.push({
      type: 'tool_call',
      payload: compactObject({
        callId: `step-${step.step_index}`,
        tool: step.tool_name ?? step.step_type,
        input: step.tool_input
      })
    });
  } else if (step.step_type.includes('tool') && step.state === 'DONE' && step.tool_output !== undefined) {
    events.push({
      type: 'tool_result',
      payload: compactObject({ callId: `step-${step.step_index}`, output: step.tool_output })
    });
  }
  if (step.usage) events.push(usageEvent(step.usage));
  return events;
}

function eventOutput(event: AntigravityStreamJsonEvent): MeshAgentOutputEvent[] {
  if (event.event === 'init') {
    if (!event.conversation_id) return [];
    return [
      {
        type: 'session_ref',
        payload: compactObject({
          providerSessionRef: event.conversation_id,
          cwd: event.init.cwd,
          permissionMode: event.init.permission_mode
        })
      }
    ];
  }
  if (event.event === 'step_update') return stepEvents(event);
  const result = event.result;
  if (result.status !== 'SUCCESS') {
    return [
      usageEvent(result.usage),
      {
        type: 'provider_error',
        payload: compactObject({
          code: result.status.toLowerCase(),
          message: result.error ?? 'Antigravity reported a failed result'
        })
      }
    ];
  }
  return [usageEvent(result.usage), { type: 'agent_message', payload: { text: result.response, final: true } }];
}

export function parseAntigravityStreamJson(chunk: string): MeshAgentOutputEvent[] {
  const events: MeshAgentOutputEvent[] = [];
  for (const rawLine of chunk.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = antigravityStreamJsonEventSchema.safeParse(json);
    if (parsed.success) events.push(...eventOutput(parsed.data));
  }
  return events;
}
