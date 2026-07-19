import type { MeshAgentOutputEvent, MeshAgentRuntimeHandle } from '@monad/sdk-atom';

import { z } from 'zod';

import { compactObject } from '../adapter-shared.ts';

// Wire contract for the Qwen Code `--output-format stream-json` channel and its `--input-format
// stream-json` control plane: one JSON object per line (JSONL). Qwen Code began as a gemini-cli fork
// but rewrote its non-interactive output layer to the Claude-Code-compatible message protocol, so —
// unlike `gemini` — it does NOT emit the flat `JsonStreamEvent` union in `gemini-stream-json.ts`.
// This schema mirrors the official `@qwen-code/sdk@0.1.8` `src/types/protocol.ts` (its `SDKMessage`
// and control-message unions) and is the single source of truth the `qwen` adapter parses against.
//
// Only the fields the daemon consumes are named; every object keeps a `catchall`, so a newer CLI
// that adds fields — or an unknown message/subtype — is skipped rather than wedging the parse
// (schema-first at the runtime boundary; see docs/engineering/conventions.md §3).

const qwenTextBlockSchema = z.object({ type: z.literal('text'), text: z.string() }).catchall(z.unknown());

const qwenThinkingBlockSchema = z.object({ type: z.literal('thinking'), thinking: z.string() }).catchall(z.unknown());

const qwenToolUseBlockSchema = z
  .object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.unknown().optional()
  })
  .catchall(z.unknown());

// `content` is recursive (a tool result may embed content blocks), but the daemon only ever renders
// it as text, so a shallow `string | unknown[]` is enough and avoids a `z.lazy` cycle.
const qwenToolResultBlockSchema = z
  .object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z.union([z.string(), z.array(z.unknown())]).optional(),
    is_error: z.boolean().optional()
  })
  .catchall(z.unknown());

export const qwenStreamJsonContentBlockSchema = z.discriminatedUnion('type', [
  qwenTextBlockSchema,
  qwenThinkingBlockSchema,
  qwenToolUseBlockSchema,
  qwenToolResultBlockSchema
]);

const qwenApiMessageSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    content: z.union([z.string(), z.array(qwenStreamJsonContentBlockSchema)])
  })
  .catchall(z.unknown());

export const qwenStreamJsonAssistantSchema = z
  .object({
    type: z.literal('assistant'),
    uuid: z.string().optional(),
    session_id: z.string().optional(),
    message: qwenApiMessageSchema,
    parent_tool_use_id: z.string().nullable().optional()
  })
  .catchall(z.unknown());

export const qwenStreamJsonUserSchema = z
  .object({
    type: z.literal('user'),
    uuid: z.string().optional(),
    session_id: z.string().optional(),
    message: qwenApiMessageSchema,
    parent_tool_use_id: z.string().nullable().optional()
  })
  .catchall(z.unknown());

export const qwenStreamJsonSystemSchema = z
  .object({
    type: z.literal('system'),
    subtype: z.string().optional(),
    session_id: z.string().optional(),
    cwd: z.string().optional(),
    model: z.string().optional(),
    permission_mode: z.string().optional()
  })
  .catchall(z.unknown());

const qwenPermissionDenialSchema = z
  .object({
    tool_name: z.string(),
    tool_use_id: z.string().optional(),
    tool_input: z.unknown().optional()
  })
  .catchall(z.unknown());

// Both `success` and `error_*` results share `type: 'result'`; the daemon branches on `subtype`
// rather than nesting a second discriminated union.
export const qwenStreamJsonResultSchema = z
  .object({
    type: z.literal('result'),
    subtype: z.string().optional(),
    session_id: z.string().optional(),
    is_error: z.boolean().optional(),
    result: z.string().optional(),
    permission_denials: z.array(qwenPermissionDenialSchema).optional(),
    error: z.object({ type: z.string().optional(), message: z.string() }).catchall(z.unknown()).optional()
  })
  .catchall(z.unknown());

// Partial (delta) streaming — only present with `--include-partial-messages`. The daemon reconstructs
// replies from the complete `assistant` message instead, so this is validated-but-ignored.
export const qwenStreamJsonPartialSchema = z
  .object({
    type: z.literal('stream_event'),
    session_id: z.string().optional(),
    event: z.object({ type: z.string() }).catchall(z.unknown()),
    parent_tool_use_id: z.string().nullable().optional()
  })
  .catchall(z.unknown());

// Control plane (`--input-format stream-json`). The CLI sends a `control_request` (e.g. `can_use_tool`
// permission prompts) that the client answers with a `control_response`; the client also drives
// `initialize` / `interrupt` the same way. Payloads stay loose (`subtype` + catchall) so every
// controller subtype validates and the adapter extracts only the fields it acts on.
//
// Caveat: Qwen Code's own docs (qwenlm.github.io/qwen-code-docs/en/users/features/headless/) label
// stream-json input mode "currently under construction and intended for SDK integration" and don't
// fully spell out this envelope. The shape here matches the Qwen Code SDK's documented `can_use_tool`
// control-request flow (its TS/Python/Java SDKs route a CLI `control_request` through a
// `canUseTool(tool_name, tool_input, context)` callback) — a Claude-Agent-SDK-compatible protocol by
// design, not a guess — but since upstream calls the raw CLI wire format unstable, it's the one part
// of this adapter most likely to need a follow-up if a future Qwen Code release changes it.
export const qwenControlRequestSchema = z
  .object({
    type: z.literal('control_request'),
    request_id: z.string(),
    request: z.object({ subtype: z.string() }).catchall(z.unknown())
  })
  .catchall(z.unknown());

export const qwenControlResponseSchema = z
  .object({
    type: z.literal('control_response'),
    response: z.object({}).catchall(z.unknown())
  })
  .catchall(z.unknown());

export const qwenControlCancelSchema = z
  .object({
    type: z.literal('control_cancel_request'),
    request_id: z.string().optional()
  })
  .catchall(z.unknown());

export const qwenStreamJsonLineSchema = z.discriminatedUnion('type', [
  qwenStreamJsonAssistantSchema,
  qwenStreamJsonUserSchema,
  qwenStreamJsonSystemSchema,
  qwenStreamJsonResultSchema,
  qwenStreamJsonPartialSchema,
  qwenControlRequestSchema,
  qwenControlResponseSchema,
  qwenControlCancelSchema
]);

export type QwenStreamJsonContentBlock = z.infer<typeof qwenStreamJsonContentBlockSchema>;
export type QwenStreamJsonAssistant = z.infer<typeof qwenStreamJsonAssistantSchema>;
export type QwenStreamJsonUser = z.infer<typeof qwenStreamJsonUserSchema>;
export type QwenStreamJsonSystem = z.infer<typeof qwenStreamJsonSystemSchema>;
export type QwenStreamJsonResult = z.infer<typeof qwenStreamJsonResultSchema>;
export type QwenStreamJsonPartial = z.infer<typeof qwenStreamJsonPartialSchema>;
export type QwenControlRequest = z.infer<typeof qwenControlRequestSchema>;
export type QwenControlResponse = z.infer<typeof qwenControlResponseSchema>;
export type QwenControlCancel = z.infer<typeof qwenControlCancelSchema>;
export type QwenStreamJsonLine = z.infer<typeof qwenStreamJsonLineSchema>;

// Qwen Code's `--output-format stream-json` emits one Claude-Code-compatible `SDKMessage` per line and,
// under `--input-format stream-json`, exchanges a `control_request`/`control_response` plane for
// permission prompts. Every line is validated against the `@monad/protocol` schema — the single source
// of truth for the wire shape — and mapped to the daemon's MeshAgent output contract through a
// type-keyed dispatch table, mirroring the codex adapter's notification handlers: a future message
// type is one table entry, not another `if` branch.

interface QwenStdin {
  write(input: string): void;
  flush?(): void | Promise<void>;
}

function serializeLine(payload: Record<string, unknown>): string {
  return `${JSON.stringify(payload)}\n`;
}

function writeLine(stdin: QwenStdin, payload: Record<string, unknown>): void {
  stdin.write(serializeLine(payload));
  void stdin.flush?.();
}

function stringifyToolResultContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) =>
        part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : ''
      )
      .join('');
    return text || JSON.stringify(content);
  }
  return content === undefined ? undefined : JSON.stringify(content);
}

// `emitText` is false for `user` messages: their text is the CLI echoing our own prompt back, and
// surfacing it would double the input as agent output. Only `assistant` text becomes an agent_message.
function contentBlockEvents(content: string | QwenStreamJsonContentBlock[], emitText: boolean): MeshAgentOutputEvent[] {
  if (typeof content === 'string') return [];
  const events: MeshAgentOutputEvent[] = [];
  let text = '';
  for (const block of content) {
    if (block.type === 'text') {
      text += block.text;
    } else if (block.type === 'tool_use') {
      events.push({
        type: 'tool_call',
        payload: compactObject({ callId: block.id, tool: block.name, input: block.input })
      });
    } else if (block.type === 'tool_result') {
      events.push({
        type: 'tool_result',
        payload: compactObject({ callId: block.tool_use_id, output: stringifyToolResultContent(block.content) })
      });
    }
  }
  if (emitText && text) events.unshift({ type: 'agent_message', payload: { text } });
  return events;
}

function systemEvents(message: QwenStreamJsonSystem): MeshAgentOutputEvent[] {
  if (!message.session_id) return [];
  return [
    {
      type: 'session_ref',
      payload: compactObject({
        providerSessionRef: message.session_id,
        cwd: message.cwd,
        model: message.model,
        permissionMode: message.permission_mode
      })
    }
  ];
}

function permissionDenialEvents(result: QwenStreamJsonResult): MeshAgentOutputEvent[] {
  const denials = result.permission_denials ?? [];
  const commands = denials
    .map((denial) => {
      const command =
        denial.tool_input && typeof (denial.tool_input as { command?: unknown }).command === 'string'
          ? (denial.tool_input as { command: string }).command
          : undefined;
      return command ? `${denial.tool_name}: ${command}` : denial.tool_name;
    })
    .filter(Boolean);
  if (commands.length === 0) return [];
  const prefix = (result.result ?? '').trim();
  const blocked = `Blocked command: ${commands.join('; ')}`;
  return [
    {
      type: 'provider_error',
      payload: { code: 'permission_denied', message: prefix ? `${prefix}\n\n${blocked}` : blocked }
    }
  ];
}

function resultEvents(message: QwenStreamJsonResult): MeshAgentOutputEvent[] {
  if (message.subtype?.startsWith('error')) {
    return [
      {
        type: 'provider_error',
        payload: compactObject({
          message: message.error?.message ?? 'Qwen reported a failed result',
          code: message.error?.type
        })
      }
    ];
  }
  return [
    { type: 'agent_message', payload: compactObject({ text: message.result || undefined, final: true }) },
    ...permissionDenialEvents(message)
  ];
}

// A `can_use_tool` request is the only control message that maps to a Monad approval; every other
// controller subtype (mcp_message, hook_callback, …) is one we never opt into, so it is auto-declined
// with an error `control_response` — mirroring the codex adapter — so an unexpected request can't hang
// the turn waiting on a reply we would never send.
function controlRequestEvents(message: QwenControlRequest, stdin?: QwenStdin): MeshAgentOutputEvent[] {
  if (message.request.subtype === 'can_use_tool') {
    const request = message.request as Record<string, unknown>;
    return [
      {
        type: 'approval_requested',
        payload: compactObject({
          requestId: message.request_id,
          kind: 'can_use_tool',
          tool: request.tool_name,
          callId: request.tool_use_id,
          input: request.input,
          permissionSuggestions: request.permission_suggestions,
          blockedPath: request.blocked_path
        })
      }
    ];
  }
  if (stdin) {
    writeLine(stdin, {
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: message.request_id,
        error: `Unsupported control request: ${message.request.subtype}`
      }
    });
  }
  return [];
}

function lineEvents(line: QwenStreamJsonLine, stdin?: QwenStdin): MeshAgentOutputEvent[] {
  switch (line.type) {
    case 'system':
      return systemEvents(line);
    case 'assistant':
      return contentBlockEvents((line as QwenStreamJsonAssistant).message.content, true);
    case 'user':
      return contentBlockEvents((line as QwenStreamJsonUser).message.content, false);
    case 'result':
      return resultEvents(line);
    case 'control_request':
      return controlRequestEvents(line, stdin);
    default:
      // stream_event (partial deltas), control_response, control_cancel_request: validated but not
      // surfaced — the reply is reconstructed from the complete `assistant` message.
      return [];
  }
}

/** Parse a Qwen Code stream-json chunk (one or more complete JSONL lines) into MeshAgent output
 *  events. `handle.stdin`, when present, lets the parser auto-decline unsupported control requests. */
export function parseQwenStreamJson(chunk: string, handle?: MeshAgentRuntimeHandle): MeshAgentOutputEvent[] {
  const stdin = handle?.stdin;
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
    const parsed = qwenStreamJsonLineSchema.safeParse(json);
    if (!parsed.success) continue;
    events.push(...lineEvents(parsed.data, stdin));
  }
  return events;
}

/** Whether a raw buffer holds at least one recognizable Qwen stream-json message — used to pick the
 *  stream-json event format over a provider-internal transcript. */
export function hasQwenStreamJsonMessages(raw: string): boolean {
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) continue;
    try {
      if (qwenStreamJsonLineSchema.safeParse(JSON.parse(line)).success) return true;
    } catch {}
  }
  return false;
}

// Qwen's SDK sends `initialize` before the first turn (Query.initialize). We register no hooks or SDK
// MCP servers, so the payload is minimal; the CLI's reply is a `control_response` the parser ignores.
export function initializeQwenStreamJson(handle: MeshAgentRuntimeHandle): void {
  if (handle.launchMode !== 'json-stream' || !handle.stdin) return;
  writeLine(handle.stdin, {
    type: 'control_request',
    request_id: `init-${handle.nextRequestId?.() ?? 0}`,
    request: { subtype: 'initialize', hooks: null }
  });
}

/** Frame a turn as the SDK's `SDKUserMessage` envelope and write it to the CLI's stream-json stdin. */
export function sendQwenStreamJsonInput(handle: MeshAgentRuntimeHandle, input: string): void {
  if (!handle.stdin) throw new Error('MeshAgent session has no stream-json input bridge');
  writeLine(handle.stdin, {
    type: 'user',
    session_id: handle.providerSessionRef ?? '',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text: input }] }
  });
}

/** Answer a `can_use_tool` permission request over the control plane. `behavior` is the CLI's wire
 *  shape (`allow` echoes the original tool input; `deny` carries a message), not `PermissionApproval`. */
export function resolveQwenStreamJsonApproval(
  handle: MeshAgentRuntimeHandle,
  resolution: { requestId: string; allow: boolean; reason?: string; request?: Record<string, unknown> }
): void {
  if (!handle.stdin) throw new Error('MeshAgent session has no stream-json approval bridge');
  const response = resolution.allow
    ? { behavior: 'allow', updatedInput: resolution.request?.input ?? {} }
    : { behavior: 'deny', message: resolution.reason ?? 'Denied' };
  writeLine(handle.stdin, {
    type: 'control_response',
    response: { subtype: 'success', request_id: resolution.requestId, response }
  });
}
