import type { NativeCliObservationEvent } from '@monad/protocol';
import type { ObservationSource } from '../observation-projection.ts';

import { observation, textValue, thinkingObservation } from '../observation-projection.ts';

export type CodexObservationResponseItem = Record<string, unknown> & { type: string };

export function isCodexObservationResponseItem(item: unknown): item is CodexObservationResponseItem {
  return (
    !!item && typeof item === 'object' && !Array.isArray(item) && typeof (item as { type?: unknown }).type === 'string'
  );
}

function codexResponseMessageContentEvents(args: {
  id: string;
  content: unknown;
  recordIndex: number;
  source: ObservationSource;
  providerEventType: string;
  createdAt?: string;
  raw: unknown;
}): NativeCliObservationEvent[] {
  if (typeof args.content === 'string') {
    return observation({
      id: `${args.id}:json:${args.recordIndex}:message`,
      role: 'agent',
      text: args.content,
      source: args.source,
      providerEventType: args.providerEventType,
      createdAt: args.createdAt,
      raw: args.raw
    });
  }
  if (!Array.isArray(args.content)) return [];
  return args.content.flatMap((part, partIndex) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return [];
    const item = part as Record<string, unknown>;
    if (item.type === 'text' || item.type === 'output_text') {
      return observation({
        id: `${args.id}:json:${args.recordIndex}:message:${partIndex}`,
        role: 'agent',
        text: textValue(item.text, item.content),
        source: args.source,
        providerEventType: args.providerEventType,
        createdAt: args.createdAt,
        raw: args.raw
      });
    }
    if (item.type === 'reasoning' || item.type === 'thinking') {
      return thinkingObservation({
        id: `${args.id}:json:${args.recordIndex}:thinking:${partIndex}`,
        text: textValue(item.text, item.content, item.summary),
        source: args.source,
        providerEventType: String(item.type),
        createdAt: args.createdAt,
        raw: args.raw
      });
    }
    if (item.type === 'tool_use') {
      const tool = textValue(item.name, item.tool) ?? 'tool';
      const input = item.input ?? item.args ?? item.arguments;
      const inputText = input === undefined ? '' : ` ${typeof input === 'string' ? input : JSON.stringify(input)}`;
      return observation({
        id: `${args.id}:json:${args.recordIndex}:tool:${partIndex}`,
        role: 'tool',
        text: `Tool call ${tool}${inputText}`,
        source: args.source,
        providerEventType: args.providerEventType,
        createdAt: args.createdAt,
        raw: args.raw
      });
    }
    if (item.type === 'tool_result') {
      return observation({
        id: `${args.id}:json:${args.recordIndex}:tool-result:${partIndex}`,
        role: 'tool',
        text: textValue(item.content, item.output, item.result) ?? JSON.stringify(item.content ?? item),
        source: args.source,
        providerEventType: args.providerEventType,
        createdAt: args.createdAt,
        raw: args.raw
      });
    }
    return [];
  });
}

export function codexResponseItem(
  id: string,
  item: CodexObservationResponseItem,
  recordIndex: number,
  source: ObservationSource,
  raw: unknown,
  createdAt?: string
): NativeCliObservationEvent[] {
  if (item.type === 'agent_message') {
    return observation({
      id: `${id}:json:${recordIndex}:agent-message`,
      role: 'agent',
      text: textValue(item.text),
      source,
      providerEventType: String(item.type),
      createdAt,
      raw
    });
  }
  if (item.type === 'reasoning' || item.type === 'thinking') {
    return thinkingObservation({
      id: `${id}:json:${recordIndex}:thinking`,
      text: textValue(item.text, item.content, item.summary),
      source,
      providerEventType: String(item.type),
      createdAt,
      raw
    });
  }
  if (item.type === 'message' && item.role === 'assistant') {
    return codexResponseMessageContentEvents({
      id,
      content: item.content,
      recordIndex,
      source,
      providerEventType: String(item.type),
      createdAt,
      raw
    });
  }
  if (item.type === 'function_call') {
    const tool = textValue(item.name) ?? 'tool';
    const args = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {});
    return observation({
      id: `${id}:json:${recordIndex}:function-call`,
      role: 'tool',
      text: `Tool call ${tool} ${args}`,
      source,
      providerEventType: String(item.type),
      createdAt,
      raw
    });
  }
  if (item.type === 'function_call_output') {
    return observation({
      id: `${id}:json:${recordIndex}:function-output`,
      role: 'tool',
      text: textValue(item.output) ?? JSON.stringify(item.output ?? item),
      source,
      providerEventType: String(item.type),
      createdAt,
      raw
    });
  }
  if (item.type === 'web_search_call') {
    return observation({
      id: `${id}:json:${recordIndex}:web-search`,
      role: 'tool',
      text: `Web search ${textValue(item.status) ?? ''}`.trim(),
      source,
      providerEventType: String(item.type),
      createdAt,
      raw
    });
  }
  return [];
}
