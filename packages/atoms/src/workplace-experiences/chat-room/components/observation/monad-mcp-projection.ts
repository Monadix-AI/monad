import type { AgentObservationEvent } from '@monad/protocol';

import { parseStreamingJson } from '../../../../agent-adapters/shared/parsing/partial-json.ts';
import { observationContractRawEvents } from './provenance.ts';

export const MONAD_MCP_TOOL_NAMES = [
  'project_post',
  'project_ask',
  'project_read',
  'project_inbox_check',
  'project_inbox_ack',
  'agent_send',
  'agent_read',
  'session_members',
  'runtime_info',
  'project_plan_list',
  'project_plan_add',
  'project_plan_update',
  'project_plan_delete'
] as const;

const CLAUDE_MONAD_MCP_PREFIX = 'mcp__monad__';
const HERMES_MONAD_MCP_PREFIX = 'mcp_monad_';
const MONAD_AGENT_MCP_PREFIX = 'monad__';

export type MonadMcpToolName = (typeof MONAD_MCP_TOOL_NAMES)[number];

export type MonadMcpAttachment = {
  path: string;
  bytes?: number;
  createdAt?: string;
  id?: string;
  name?: string;
  mime?: string;
};

export type MonadMcpMessage = {
  id: string;
  agentId?: string;
  agentName?: string;
  attachments: MonadMcpAttachment[];
  createdAt?: string;
  name?: string;
  role?: string;
  text: string;
};

export type MonadMcpQuestion = {
  allowOther?: boolean;
  id?: string;
  mode?: 'single' | 'multiple';
  options: string[];
  question: string;
};

type MonadMcpToolBase = {
  toolName: MonadMcpToolName;
  callId?: string;
  status?: string;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  isError: boolean;
};

export type MonadMcpToolView =
  | (MonadMcpToolBase & {
      action: 'project-post';
      text?: string;
      threadId?: string;
      attachments: MonadMcpAttachment[];
    })
  | (MonadMcpToolBase & {
      action: 'project-ask';
      question?: string;
      options: string[];
      questions?: MonadMcpQuestion[];
      mode?: 'single' | 'multiple';
      allowOther?: boolean;
    })
  | (MonadMcpToolBase & {
      action: 'project-read';
      threadId?: string;
      before?: string;
      after?: string;
      around?: string;
      limit?: number;
      messages?: MonadMcpMessage[];
    })
  | (MonadMcpToolBase & { action: 'project-inbox-check' })
  | (MonadMcpToolBase & { action: 'project-inbox-ack'; cursor?: number })
  | (MonadMcpToolBase & {
      action: 'agent-send';
      to?: string;
      text?: string;
      attachments: MonadMcpAttachment[];
    })
  | (MonadMcpToolBase & {
      action: 'agent-read';
      with?: string;
      before?: string;
      after?: string;
      limit?: number;
    })
  | (MonadMcpToolBase & { action: 'session-members' })
  | (MonadMcpToolBase & { action: 'runtime-info' })
  | (MonadMcpToolBase & { action: 'project-plan-list' })
  | (MonadMcpToolBase & { action: 'project-plan-add' })
  | (MonadMcpToolBase & { action: 'project-plan-update' })
  | (MonadMcpToolBase & { action: 'project-plan-delete' });

export function monadMcpToolView(
  call: AgentObservationEvent,
  result: AgentObservationEvent | undefined,
  contractEvents: readonly unknown[]
): MonadMcpToolView | null {
  const rawEvents = observationContractRawEvents(contractEvents);
  const wrappedCall = wrappedMonadMcpCall(call.tool?.name, call.tool?.input);
  const toolName = wrappedCall?.toolName ?? monadMcpToolName(call, result, rawEvents);
  if (!toolName) return null;

  const parsedInput = inputRecordValue(wrappedCall?.input ?? call.tool?.input);
  // A live wire that only signals tool lifecycle (openclaw's `item` stream) carries no arguments at
  // all. The prefixed name alone already identifies the Monad MCP tool, so an ABSENT input must not
  // demote the call to a generic card — the paired transcript result supplies the payload later.
  // Present-but-malformed input still falls back: the generic card shows the raw input verbatim.
  const inputAbsent = (wrappedCall?.input ?? call.tool?.input) === undefined;
  const unambiguouslyMonadMcp =
    wrappedCall !== undefined || prefixedMonadMcpToolName(call.tool?.name ?? '') !== undefined;
  if (!parsedInput && !call.streaming && !(unambiguouslyMonadMcp && inputAbsent)) return null;
  const record = parsedInput ?? {};
  const input = record;
  // Transport envelopes are the producing adapter's problem (normalizedMcpToolOutput at emission);
  // by the time an event reaches this projection, `tool.output` IS the payload.
  const output = result?.tool?.output ?? (result?.hasContent === false ? undefined : result?.text);
  const status = result?.tool?.status ?? call.tool?.status;
  const durationMs = result?.tool?.durationMs ?? call.tool?.durationMs;
  const callId = call.tool?.callId ?? result?.tool?.callId;
  const base: MonadMcpToolBase = {
    toolName,
    ...(callId ? { callId } : {}),
    ...(status === undefined ? {} : { status }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    isError: statusIsError(status) || rawMcpResultIsError(rawEvents)
  };
  switch (toolName) {
    case 'project_post': {
      const inputAttachments = attachments(record.attachments);
      const outputAttachments = messageAttachments(output);
      return {
        ...base,
        action: 'project-post',
        ...optionalString('text', record.text),
        ...optionalString('threadId', record.threadId),
        attachments: outputAttachments.length > 0 ? outputAttachments : inputAttachments
      };
    }
    case 'project_ask': {
      const questions = questionArray(record.questions);
      return {
        ...base,
        action: 'project-ask',
        ...optionalString('question', record.question),
        options: stringArray(record.options),
        ...(questions.length > 0 ? { questions } : {}),
        ...optionalMode(record.mode),
        ...optionalBoolean('allowOther', record.allowOther)
      };
    }
    case 'project_read': {
      const messages = projectMessages(output);
      return {
        ...base,
        action: 'project-read',
        ...optionalString('threadId', record.threadId),
        ...optionalString('before', record.before),
        ...optionalString('after', record.after),
        ...optionalString('around', record.around),
        ...optionalNumber('limit', record.limit),
        ...(messages === undefined ? {} : { messages })
      };
    }
    case 'project_inbox_check':
      return { ...base, action: 'project-inbox-check' };
    case 'project_inbox_ack':
      return { ...base, action: 'project-inbox-ack', ...optionalNumber('cursor', record.cursor) };
    case 'agent_send': {
      const inputAttachments = attachments(record.attachments);
      const outputAttachments = messageAttachments(output);
      return {
        ...base,
        action: 'agent-send',
        ...optionalString('to', record.to),
        ...optionalString('text', record.text),
        attachments: outputAttachments.length > 0 ? outputAttachments : inputAttachments
      };
    }
    case 'agent_read':
      return {
        ...base,
        action: 'agent-read',
        ...optionalString('with', record.with),
        ...optionalString('before', record.before),
        ...optionalString('after', record.after),
        ...optionalNumber('limit', record.limit)
      };
    case 'session_members':
      return { ...base, action: 'session-members' };
    case 'runtime_info':
      return { ...base, action: 'runtime-info' };
    case 'project_plan_list':
      return { ...base, action: 'project-plan-list' };
    case 'project_plan_add':
      return { ...base, action: 'project-plan-add' };
    case 'project_plan_update':
      return { ...base, action: 'project-plan-update' };
    case 'project_plan_delete':
      return { ...base, action: 'project-plan-delete' };
  }
}

function wrappedMonadMcpCall(
  name: string | undefined,
  input: unknown
): { toolName: MonadMcpToolName; input: Record<string, unknown> } | undefined {
  if (name !== 'monad') return undefined;
  const envelope = inputRecordValue(input);
  if (!envelope) return undefined;
  const toolName = envelope.tool ?? envelope.toolName;
  if (typeof toolName !== 'string' || !isMonadMcpToolName(toolName)) return undefined;
  const nestedInput = inputRecordValue(envelope.arguments ?? envelope.input ?? envelope.args);
  return { toolName, input: nestedInput ?? {} };
}

function monadMcpToolName(
  call: AgentObservationEvent,
  result: AgentObservationEvent | undefined,
  contractEvents: readonly unknown[]
): MonadMcpToolName | undefined {
  const name = call.tool?.name ?? result?.tool?.name;
  if (!name) return undefined;
  const prefixedName = prefixedMonadMcpToolName(name);
  if (prefixedName) return prefixedName;
  const provenanceName = monadMcpProvenanceToolName(contractEvents);
  if (!provenanceName) return undefined;
  return name === 'tool' || name === provenanceName ? provenanceName : undefined;
}

function prefixedMonadMcpToolName(name: string): MonadMcpToolName | undefined {
  for (const prefix of [CLAUDE_MONAD_MCP_PREFIX, HERMES_MONAD_MCP_PREFIX, MONAD_AGENT_MCP_PREFIX]) {
    if (!name.startsWith(prefix)) continue;
    const candidate = name.slice(prefix.length);
    if (isMonadMcpToolName(candidate)) return candidate;
  }
  return undefined;
}

function isMonadMcpToolName(value: string): value is MonadMcpToolName {
  return (MONAD_MCP_TOOL_NAMES as readonly string[]).includes(value);
}

function monadMcpProvenanceToolName(contractEvents: readonly unknown[]): MonadMcpToolName | undefined {
  for (const event of contractEvents) {
    const record = recordValue(event);
    const item = recordValue(recordValue(record?.params)?.item);
    for (const payload of [item, ...mcpPayloads(record)]) {
      const toolName = monadMcpPayloadToolName(payload);
      if (toolName) return toolName;
    }
  }
  return undefined;
}

function monadMcpPayloadToolName(payload: Record<string, unknown> | undefined): MonadMcpToolName | undefined {
  if (!payload) return undefined;
  const invocation = recordValue(payload.invocation);
  const server = payload.server ?? payload.serverName ?? invocation?.server;
  const tool = payload.tool ?? payload.toolName ?? invocation?.tool;
  return server === 'monad' && typeof tool === 'string' && isMonadMcpToolName(tool) ? tool : undefined;
}

function mcpPayloads(record: Record<string, unknown> | undefined): Record<string, unknown>[] {
  if (!record) return [];
  const directPayload = recordValue(record.payload);
  const data = recordValue(record.data);
  const dataPayload = recordValue(data?.payload);
  const params = recordValue(record.params);
  return [
    record,
    ...(directPayload ? [directPayload] : []),
    ...(data ? [data] : []),
    ...(dataPayload ? [dataPayload] : []),
    ...(params ? [params] : [])
  ];
}

function rawMcpResultIsError(contractEvents: readonly unknown[]): boolean {
  return contractEvents.some((event) => {
    const record = recordValue(event);
    const item = recordValue(recordValue(record?.params)?.item);
    if (mcpResultIsError(item?.result)) return true;
    return mcpPayloads(record).some((payload) => mcpResultIsError(payload.result));
  });
}

function mcpResultIsError(value: unknown): boolean {
  const result = recordValue(value);
  if (!result) return false;
  if (result.Err !== undefined && result.Err !== null) return true;
  if (result.isError === true || (result.error !== undefined && result.error !== null)) return true;
  const ok = recordValue(result.Ok);
  return ok?.isError === true || (ok?.error !== undefined && ok.error !== null);
}

function statusIsError(status: string | undefined): boolean {
  const normalized = status?.trim().toLowerCase();
  return normalized === 'failed' || normalized === 'error';
}

function attachments(value: unknown): MonadMcpAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = recordValue(entry);
    if (!record || typeof record.path !== 'string' || !record.path.trim()) return [];
    return [
      {
        path: record.path,
        ...optionalNumber('bytes', record.bytes),
        ...optionalString('createdAt', record.createdAt),
        ...optionalString('id', record.id),
        ...optionalString('name', record.name),
        ...optionalString('mime', record.mime)
      }
    ];
  });
}

function questionArray(value: unknown): MonadMcpQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = recordValue(entry);
    if (!record || typeof record.question !== 'string' || !record.question.trim()) return [];
    return [
      {
        ...optionalBoolean('allowOther', record.allowOther),
        ...optionalString('id', record.id),
        ...optionalMode(record.mode),
        options: stringArray(record.options),
        question: record.question
      }
    ];
  });
}

function projectMessages(value: unknown): MonadMcpMessage[] | undefined {
  const record = projectMessageRecord(value, 0);
  if (!record || !Array.isArray(record.messages)) return undefined;
  return record.messages.flatMap((entry, index) => {
    const message = recordValue(entry);
    if (!message || typeof message.text !== 'string') return [];
    const data = recordValue(message.data);
    const name = [data?.agentDisplayName, data?.displayName, data?.agentName, message.name].find(
      (candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0
    );
    const agentId = [data?.memberId, message.memberId].find(
      (candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0
    );
    const agentName = [data?.agentName, message.agentName].find(
      (candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0
    );
    const id = [message.id, message.messageId].find(
      (candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0
    );
    const messageAttachments = attachments(data?.attachments ?? message.attachments);
    if (!message.text.trim() && messageAttachments.length === 0) return [];
    return [
      {
        id: id ?? `message-${index}`,
        ...(agentId ? { agentId } : {}),
        ...(agentName ? { agentName } : {}),
        attachments: messageAttachments,
        ...optionalString('createdAt', message.createdAt),
        ...(name ? { name } : {}),
        ...optionalString('role', message.role),
        text: message.text
      }
    ];
  });
}

function messageAttachments(value: unknown): MonadMcpAttachment[] {
  const record = messageResultRecord(value, 0);
  if (!record) return [];
  const message = recordValue(record.message);
  return attachments(message?.attachments ?? record.attachments);
}

function messageResultRecord(value: unknown, depth: number): Record<string, unknown> | undefined {
  if (depth >= 4) return undefined;
  const parsed = jsonValue(value);
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      const block = recordValue(entry);
      const nested = messageResultRecord(block?.text ?? entry, depth + 1);
      if (nested) return nested;
    }
    return undefined;
  }
  const record = recordValue(parsed);
  if (!record) return undefined;
  const message = recordValue(record.message);
  if (Array.isArray(record.attachments) || Array.isArray(message?.attachments)) return record;
  for (const candidate of [record.Ok, record.result, record.structuredContent, record.content]) {
    const nested = messageResultRecord(candidate, depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

function projectMessageRecord(value: unknown, depth: number): Record<string, unknown> | undefined {
  if (depth >= 4) return undefined;
  const parsed = jsonValue(value);
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      const block = recordValue(entry);
      const nested = projectMessageRecord(block?.text ?? entry, depth + 1);
      if (nested) return nested;
    }
    return undefined;
  }
  const record = recordValue(parsed);
  if (!record) return undefined;
  if (Array.isArray(record.messages)) return record;
  for (const candidate of [record.Ok, record.result, record.structuredContent, record.content]) {
    const nested = projectMessageRecord(candidate, depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
}

function optionalMode(value: unknown): { mode?: 'single' | 'multiple' } {
  return value === 'single' || value === 'multiple' ? { mode: value } : {};
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function inputRecordValue(value: unknown): Record<string, unknown> | undefined {
  const record = recordValue(value);
  if (record) return record;
  if (typeof value !== 'string') return undefined;
  return recordValue(parseStreamingJson(value));
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function optionalString<Key extends string>(key: Key, value: unknown): Partial<Record<Key, string>> {
  return typeof value === 'string' && value.trim() ? ({ [key]: value } as Partial<Record<Key, string>>) : {};
}

function optionalNumber<Key extends string>(key: Key, value: unknown): Partial<Record<Key, number>> {
  return typeof value === 'number' && Number.isFinite(value) ? ({ [key]: value } as Partial<Record<Key, number>>) : {};
}

function optionalBoolean<Key extends string>(key: Key, value: unknown): Partial<Record<Key, boolean>> {
  return typeof value === 'boolean' ? ({ [key]: value } as Partial<Record<Key, boolean>>) : {};
}
