import type { AgentObservationEvent } from '@monad/protocol';

import { observationContractRawEvents } from './provenance.ts';

const MONAD_MCP_TOOL_NAMES = [
  'project_post',
  'project_ask',
  'project_read',
  'project_inbox_check',
  'project_inbox_ack',
  'agent_send',
  'agent_read',
  'session_members',
  'runtime_info'
] as const;

const CLAUDE_MONAD_MCP_PREFIX = 'mcp__monad__';

export type MonadMcpToolName = (typeof MONAD_MCP_TOOL_NAMES)[number];

export type MonadMcpAttachment = {
  path: string;
  name?: string;
  mime?: string;
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
  | (MonadMcpToolBase & { action: 'runtime-info' });

export function monadMcpToolView(
  call: AgentObservationEvent,
  result: AgentObservationEvent,
  contractEvents: readonly unknown[]
): MonadMcpToolView | null {
  const rawEvents = observationContractRawEvents(contractEvents);
  const toolName = monadMcpToolName(call, result, rawEvents);
  if (!toolName) return null;

  const input = call.tool?.input;
  const record = recordValue(input);
  if (!record) return null;
  const output = result.tool?.output ?? result.text;
  const status = result.tool?.status ?? call.tool?.status;
  const durationMs = result.tool?.durationMs ?? call.tool?.durationMs;
  const base: MonadMcpToolBase = {
    toolName,
    ...((call.tool?.callId ?? result.tool?.callId) ? { callId: call.tool?.callId ?? result.tool?.callId } : {}),
    ...(status === undefined ? {} : { status }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    isError: statusIsError(status) || rawMcpResultIsError(rawEvents)
  };
  switch (toolName) {
    case 'project_post':
      return {
        ...base,
        action: 'project-post',
        ...optionalString('text', record.text),
        ...optionalString('threadId', record.threadId),
        attachments: attachments(record.attachments)
      };
    case 'project_ask':
      return {
        ...base,
        action: 'project-ask',
        ...optionalString('question', record.question),
        options: stringArray(record.options),
        ...optionalMode(record.mode),
        ...optionalBoolean('allowOther', record.allowOther)
      };
    case 'project_read':
      return {
        ...base,
        action: 'project-read',
        ...optionalString('threadId', record.threadId),
        ...optionalString('before', record.before),
        ...optionalString('after', record.after),
        ...optionalString('around', record.around),
        ...optionalNumber('limit', record.limit)
      };
    case 'project_inbox_check':
      return { ...base, action: 'project-inbox-check' };
    case 'project_inbox_ack':
      return { ...base, action: 'project-inbox-ack', ...optionalNumber('cursor', record.cursor) };
    case 'agent_send':
      return {
        ...base,
        action: 'agent-send',
        ...optionalString('to', record.to),
        ...optionalString('text', record.text),
        attachments: attachments(record.attachments)
      };
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
  }
}

function monadMcpToolName(
  call: AgentObservationEvent,
  result: AgentObservationEvent,
  contractEvents: readonly unknown[]
): MonadMcpToolName | undefined {
  const name = call.tool?.name ?? result.tool?.name;
  if (!name) return undefined;
  const claudeName = claudeMonadMcpToolName(name);
  if (claudeName) return claudeName;
  return isMonadMcpToolName(name) && hasCodexMonadProvenance(contractEvents, name) ? name : undefined;
}

function claudeMonadMcpToolName(name: string): MonadMcpToolName | undefined {
  if (!name.startsWith(CLAUDE_MONAD_MCP_PREFIX)) return undefined;
  const candidate = name.slice(CLAUDE_MONAD_MCP_PREFIX.length);
  return isMonadMcpToolName(candidate) ? candidate : undefined;
}

function isMonadMcpToolName(value: string): value is MonadMcpToolName {
  return (MONAD_MCP_TOOL_NAMES as readonly string[]).includes(value);
}

function hasCodexMonadProvenance(contractEvents: readonly unknown[], toolName: MonadMcpToolName): boolean {
  return contractEvents.some((event) => {
    const record = recordValue(event);
    const item = recordValue(recordValue(record?.params)?.item);
    if (item?.type === 'mcpToolCall' && item.server === 'monad' && item.tool === toolName) return true;
    return mcpPayloads(record).some((payload) => {
      const invocation = recordValue(payload.invocation);
      return invocation?.server === 'monad' && invocation.tool === toolName;
    });
  });
}

function rawMcpResultIsError(contractEvents: readonly unknown[]): boolean {
  return contractEvents.some((event) => {
    const record = recordValue(event);
    const item = recordValue(recordValue(record?.params)?.item);
    if (mcpResultIsError(item?.result)) return true;
    return mcpPayloads(record).some((payload) => mcpResultIsError(payload.result));
  });
}

function mcpPayloads(record: Record<string, unknown> | undefined): Record<string, unknown>[] {
  if (!record) return [];
  const directPayload = recordValue(record.payload);
  const dataPayload = recordValue(recordValue(record.data)?.payload);
  return [record, ...(directPayload ? [directPayload] : []), ...(dataPayload ? [dataPayload] : [])];
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
        ...optionalString('name', record.name),
        ...optionalString('mime', record.mime)
      }
    ];
  });
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

function optionalString<Key extends string>(key: Key, value: unknown): Partial<Record<Key, string>> {
  return typeof value === 'string' && value.trim() ? ({ [key]: value } as Partial<Record<Key, string>>) : {};
}

function optionalNumber<Key extends string>(key: Key, value: unknown): Partial<Record<Key, number>> {
  return typeof value === 'number' && Number.isFinite(value) ? ({ [key]: value } as Partial<Record<Key, number>>) : {};
}

function optionalBoolean<Key extends string>(key: Key, value: unknown): Partial<Record<Key, boolean>> {
  return typeof value === 'boolean' ? ({ [key]: value } as Partial<Record<Key, boolean>>) : {};
}
