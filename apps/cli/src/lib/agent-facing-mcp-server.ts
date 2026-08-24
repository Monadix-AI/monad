import type { MonadClient } from '@monad/client';

import { type CallToolResult, Server } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import {
  messageIdSchema,
  nativeAgentProjectPlanAddRequestSchema,
  nativeAgentProjectPlanDeleteRequestSchema,
  nativeAgentProjectPlanUpdateRequestSchema
} from '@monad/protocol';
import { z } from 'zod';

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: JsonRpcId; result: unknown }
  | { jsonrpc: '2.0'; id: JsonRpcId; error: { code: number; message: string } };

type ToolCallParams = {
  name?: unknown;
  arguments?: unknown;
};

type ToolInputSchema = { type: 'object' } & Record<string, unknown>;

type ToolDef = {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
};

type TreatyResult<T> = { data: T | null; error?: unknown; status: number };

const PROTOCOL_VERSION = '2025-06-18';
const MUTATING_TOOLS = new Set([
  'project_post',
  'project_ask',
  'agent_send',
  'project_plan_add',
  'project_plan_update',
  'project_plan_delete'
]);
const IDEMPOTENCY_CACHE_LIMIT = 256;
const MAX_JSON_RPC_LINE_BYTES = 48 * 1024;
const PROJECT_READ_SNAPSHOT_LIMIT = 16;
const PROJECT_READ_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const PROJECT_READ_SNAPSHOT_TTL_MS = 5 * 60 * 1_000;
const TOOL_CALL_DEADLINE_MS = 30_000;
const PROJECT_ASK_DEADLINE_GRACE_MS = 5_000;
const PROJECT_ASK_RECONCILIATION_TIMEOUT_MS = 5_000;
const DEFAULT_NON_BLOCKING_PROJECT_ASK_AUTO_RESOLUTION_MS = 240_000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

type ToolSuccess = { content: Array<{ type: 'text'; text: string }>; isError: false };

type ProjectReadSnapshot = Readonly<{
  id: string;
  bytes: Uint8Array;
  totalBytes: number;
  sha256: string;
  createdAt: number;
}>;

// Tools whose daemon side keeps its own fingerprint-aware idempotency ledger (session_plan_mutations
// rejects a reused requestId that carries a DIFFERENT command as `idempotency_conflict`). For these the
// proxy folds a payload fingerprint into its cache key, so a same-requestId/different-payload call misses
// the proxy cache and reaches that daemon guard instead of being served the prior call's result. Tools
// absent here (messaging) have no daemon ledger, so the payload-blind requestId key is their idempotency.
const DAEMON_FINGERPRINTED_TOOLS = new Set(['project_plan_add', 'project_plan_update', 'project_plan_delete']);

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

function runtimeHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (Bun.env.MONAD_MESH_SESSION_ID) headers['x-monad-mesh-session-id'] = Bun.env.MONAD_MESH_SESSION_ID;
  return headers;
}

function treatyOptions(
  headers: Record<string, string>,
  signal?: AbortSignal
): {
  headers: Record<string, string>;
  fetch: RequestInit;
} {
  return { headers, fetch: { signal } };
}

function objectArgs(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringArg(args: Record<string, unknown>, name: string, required: true): string;
function stringArg(args: Record<string, unknown>, name: string, required?: false): string | undefined;
function stringArg(args: Record<string, unknown>, name: string, required = false): string | undefined {
  const value = args[name];
  if (typeof value === 'string' && value.trim()) return value;
  if (required) throw new Error(`${name} is required`);
  return undefined;
}

function messageIdArg(args: Record<string, unknown>, name: string) {
  const value = stringArg(args, name);
  return value === undefined ? undefined : messageIdSchema.parse(value);
}

function deliveryModeArg(args: Record<string, unknown>): 'queue' | 'steer' {
  return args.deliveryMode === 'steer' ? 'steer' : 'queue';
}

function numberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanArg(args: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const value = args[name];
  return typeof value === 'boolean' ? value : fallback;
}

function stringArrayArg(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function projectQuestionsArg(args: Record<string, unknown>) {
  const value = args.questions;
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    const question = objectArgs(item);
    const text = stringArg(question, 'question');
    if (!text) return [];
    return [
      {
        id: stringArg(question, 'id') ?? `q${index + 1}`,
        question: text,
        options: stringArrayArg(question, 'options'),
        mode: stringArg(question, 'mode') === 'multiple' ? ('multiple' as const) : ('single' as const),
        allowOther: booleanArg(question, 'allowOther', true)
      }
    ];
  });
}

function attachmentsArg(
  args: Record<string, unknown>
): Array<{ path: string; name?: string; mime?: string }> | undefined {
  const value = args.attachments;
  if (!Array.isArray(value)) return undefined;
  const attachments = value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.path !== 'string' || !record.path) return [];
    return [
      {
        path: record.path,
        ...(typeof record.name === 'string' && record.name ? { name: record.name } : {}),
        ...(typeof record.mime === 'string' && record.mime ? { mime: record.mime } : {})
      }
    ];
  });
  return attachments.length ? attachments : undefined;
}

function toolResult(data: unknown): ToolSuccess {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError: false };
}

function toolError(error: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: message }], isError: true };
}

function treatyErrorMessage(error: unknown): string {
  if (!error) return '';
  if (typeof error === 'string') return error;
  // Eden's treaty error is an Error instance that carries the parsed daemon body on `.value` and sets
  // `.message` to a useless String(body) === "[object Object]". Inspect the body's `value`/`code`/`error`
  // BEFORE falling back to `.message`, so a fenced 403 surfaces its real code instead of "[object Object]".
  if (typeof error === 'object') {
    const record = error as Record<string, unknown>;
    for (const key of ['value', 'body', 'response']) {
      const nested = treatyErrorMessage(record[key]);
      if (nested) return nested;
    }
    if (typeof record.error === 'string') {
      return typeof record.code === 'string' ? `${record.code}: ${record.error}` : record.error;
    }
    if (typeof record.message === 'string' && record.message && record.message !== '[object Object]') {
      return record.message;
    }
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function requireNativeAgentData<T>(toolName: string, result: TreatyResult<T>): T {
  if (result.data !== null) return result.data;
  const detail = treatyErrorMessage(result.error);
  throw new Error(`${toolName} request failed: ${result.status}${detail ? ` ${detail}` : ''}`);
}

function logNativeAgentMcpError(toolName: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  const record = {
    event: 'native_agent_mcp_tool_error',
    toolName,
    meshSessionId: Bun.env.MONAD_MESH_SESSION_ID,
    serverUrl: Bun.env.MONAD_SERVER_URL,
    message,
    ...(stack ? { stack } : {})
  };
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

function schema(properties: Record<string, unknown>, required: string[] = []): ToolInputSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

function jsonRpcLineBytes(id: JsonRpcId, result: unknown): number {
  return textEncoder.encode(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`).byteLength;
}

function utf8BoundaryAtOrBefore(bytes: Uint8Array, offset: number): number {
  let boundary = Math.min(offset, bytes.byteLength);
  while (boundary > 0 && boundary < bytes.byteLength) {
    const byte = bytes[boundary];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    boundary--;
  }
  return boundary;
}

const REQUEST_ID_DESCRIPTION =
  'Stable idempotency key for this intended side effect. Reuse it when retrying the same action.';
const ASSIGNEE_DESCRIPTION = 'Assign this to-do to a project member by their canonical projectMemberId.';
const PATCH_ASSIGNEE_DESCRIPTION = 'Set the assignee by projectMemberId, or null to clear it.';

const requestIdProperty = { type: 'string', description: REQUEST_ID_DESCRIPTION };

type JsonSchemaProperties = Record<string, Record<string, unknown> | undefined>;
type JsonSchemaObject = { properties: JsonSchemaProperties; [key: string]: unknown };

function describeField(properties: JsonSchemaProperties, key: string, description: string): void {
  const field = properties[key];
  if (field) field.description = description;
}

// The plan tools' MCP input schema is derived from the same protocol request schema the daemon parses, so
// the contract the agent sees (id patterns, text/version bounds, enum) can't drift from the wire truth.
// z.toJSONSchema can't represent a `.refine` (it drops the patch "at least one field" rule under
// `unrepresentable: 'any'`), so `describe` re-expresses that one rule as `minProperties` and attaches the
// agent-facing field descriptions — it never re-declares a field type.
function planToolInputSchema(
  requestSchema: z.ZodType,
  describe: (properties: JsonSchemaProperties) => void = () => {}
): ToolInputSchema {
  // z.toJSONSchema returns a plain JSON Schema but keeps a non-enumerable `~standard` marker on it; the
  // JSON round-trip drops that (and the `$schema` header) so the published contract is exactly the wire keys.
  const json = JSON.parse(
    JSON.stringify(z.toJSONSchema(requestSchema, { unrepresentable: 'any', target: 'draft-07' }))
  ) as JsonSchemaObject & { $schema?: unknown };
  delete json.$schema;
  if (json.type !== 'object') throw new Error('plan tool input schema must be an object');
  describeField(json.properties, 'requestId', REQUEST_ID_DESCRIPTION);
  describe(json.properties);
  return { ...json, type: 'object' };
}

const planAddInputSchema = planToolInputSchema(nativeAgentProjectPlanAddRequestSchema, (properties) => {
  describeField(properties, 'assigneeProjectMemberId', ASSIGNEE_DESCRIPTION);
});
const planUpdateInputSchema = planToolInputSchema(nativeAgentProjectPlanUpdateRequestSchema, (properties) => {
  const patch = properties.patch as JsonSchemaObject | undefined;
  if (!patch) return;
  patch.minProperties = 1;
  describeField(patch.properties, 'assigneeProjectMemberId', PATCH_ASSIGNEE_DESCRIPTION);
});
const planDeleteInputSchema = planToolInputSchema(nativeAgentProjectPlanDeleteRequestSchema);

const tools: ToolDef[] = [
  {
    name: 'project_post',
    description:
      'Post a public message to the current Workplace Project transcript and broadcast it to all other members regardless of mentions. deliveryMode=steer best-effort injects it into supported active recipient turns; otherwise it queues normally.',
    inputSchema: schema(
      {
        requestId: requestIdProperty,
        deliveryMode: { type: 'string', enum: ['queue', 'steer'], default: 'queue' },
        text: { type: 'string' },
        replyToMessageId: { type: 'string' },
        attachments: {
          type: 'array',
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, name: { type: 'string' }, mime: { type: 'string' } },
            required: ['path'],
            additionalProperties: false
          }
        }
      },
      ['requestId']
    )
  },
  {
    name: 'project_ask',
    description: 'Ask the human operator one card of one or more questions.',
    inputSchema: schema(
      {
        requestId: requestIdProperty,
        question: { type: 'string' },
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              question: { type: 'string' },
              options: { type: 'array', items: { type: 'string' } },
              mode: { type: 'string', enum: ['single', 'multiple'] },
              allowOther: { type: 'boolean' }
            },
            required: ['question'],
            additionalProperties: false
          }
        },
        options: { type: 'array', items: { type: 'string' } },
        mode: { type: 'string', enum: ['single', 'multiple'] },
        allowOther: { type: 'boolean' },
        blocking: { type: 'boolean' },
        autoResolutionMs: { type: 'number', minimum: 60000, maximum: 240000 }
      },
      ['requestId']
    )
  },
  {
    name: 'project_read',
    description:
      'Read project transcript history without consuming pending inbox items. Returns an exact message or bounded window.',
    inputSchema: schema({
      messageId: { type: 'string' },
      before: { type: 'string' },
      after: { type: 'string' },
      around: { type: 'string' },
      limit: { type: 'number' },
      cursor: { type: 'string' }
    })
  },
  {
    name: 'project_inbox_check',
    description:
      'Consume pending project-room and incoming DM items for this managed MeshAgent as one ingress-ordered batch.',
    inputSchema: schema({})
  },
  {
    name: 'project_inbox_ack',
    description: 'Idempotent compatibility acknowledgement for an already checked inbox cursor.',
    inputSchema: schema({ cursor: { type: 'number' } })
  },
  {
    name: 'agent_send',
    description:
      'Send a private direct message to another Monad agent or human. This does not enter the project transcript. deliveryMode=steer best-effort injects it into a supported active recipient turn; otherwise it queues normally.',
    inputSchema: schema(
      {
        requestId: requestIdProperty,
        to: { type: 'string' },
        deliveryMode: { type: 'string', enum: ['queue', 'steer'], default: 'queue' },
        text: { type: 'string' },
        attachments: {
          type: 'array',
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, name: { type: 'string' }, mime: { type: 'string' } },
            required: ['path'],
            additionalProperties: false
          }
        }
      },
      ['requestId', 'to']
    )
  },
  {
    name: 'agent_read',
    description:
      'Read private direct conversation history with another Monad agent or human without consuming pending inbox items.',
    inputSchema: schema(
      { with: { type: 'string' }, before: { type: 'string' }, after: { type: 'string' }, limit: { type: 'number' } },
      ['with']
    )
  },
  {
    name: 'session_members',
    description: 'List current session members and whether Monad can deliver messages to them.',
    inputSchema: schema({})
  },
  {
    name: 'runtime_info',
    description: 'Show the current managed MeshAgent runtime binding.',
    inputSchema: schema({})
  },
  {
    name: 'project_plan_list',
    description: 'List the shared durable to-do plan for the current session. Returns an empty plan when untouched.',
    inputSchema: schema({})
  },
  {
    name: 'project_plan_add',
    description: 'Add one to-do to the current session plan. Optionally set its status and assign it to a member.',
    inputSchema: planAddInputSchema
  },
  {
    name: 'project_plan_update',
    description:
      'Update one to-do (text, status, and/or assignee). Provide the version you read; a stale version is rejected.',
    inputSchema: planUpdateInputSchema
  },
  {
    name: 'project_plan_delete',
    description: 'Delete one to-do. Provide the version you read; a stale version is rejected.',
    inputSchema: planDeleteInputSchema
  }
];

function nativeAgentProjectAsk(client: MonadClient) {
  return client.treaty.v1.internal['native-agent']
    .project as (typeof client.treaty.v1.internal)['native-agent']['project'] & {
    ask: {
      post: (
        body: unknown,
        options?: { headers?: Record<string, string>; fetch?: RequestInit }
      ) => Promise<{ data: unknown | null; status: number }>;
      cancel: {
        post: (
          body: unknown,
          options?: { headers?: Record<string, string>; fetch?: RequestInit }
        ) => Promise<{ data: unknown | null; status: number }>;
      };
    };
  };
}

async function callTool(
  client: MonadClient,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<unknown> {
  const headers = runtimeHeaders();
  const nativeAgent = client.treaty.v1.internal['native-agent'];
  if (name === 'project_post') {
    const text = stringArg(args, 'text');
    const attachments = attachmentsArg(args);
    const replyToMessageId = messageIdArg(args, 'replyToMessageId');
    return requireNativeAgentData(
      name,
      await nativeAgent.project.post.post(
        {
          requestId: stringArg(args, 'requestId', true),
          deliveryMode: deliveryModeArg(args),
          ...(replyToMessageId ? { replyToMessageId } : {}),
          ...(text ? { text } : {}),
          ...(attachments ? { attachments } : {})
        },
        treatyOptions(headers, signal)
      )
    );
  }
  if (name === 'project_ask') {
    const questions = projectQuestionsArg(args);
    const question = stringArg(args, 'question');
    if (questions.length === 0 && !question) throw new Error('project_ask requires question or questions');
    return requireNativeAgentData(
      name,
      await nativeAgentProjectAsk(client).ask.post(
        {
          requestId: stringArg(args, 'requestId', true),
          ...(questions.length
            ? { questions }
            : {
                question,
                options: stringArrayArg(args, 'options'),
                mode: stringArg(args, 'mode') === 'multiple' ? 'multiple' : 'single',
                allowOther: booleanArg(args, 'allowOther', true)
              }),
          blocking: booleanArg(args, 'blocking', false),
          ...(numberArg(args, 'autoResolutionMs') === undefined
            ? {}
            : { autoResolutionMs: numberArg(args, 'autoResolutionMs') })
        },
        treatyOptions(headers, signal)
      )
    );
  }
  if (name === 'project_read') {
    const messageId = messageIdArg(args, 'messageId');
    return requireNativeAgentData(
      name,
      await nativeAgent.project.read.post(
        {
          ...(messageId ? { messageId } : {}),
          before: stringArg(args, 'before'),
          after: stringArg(args, 'after'),
          around: stringArg(args, 'around'),
          limit: numberArg(args, 'limit')
        },
        treatyOptions(headers, signal)
      )
    );
  }
  if (name === 'project_inbox_check') {
    return requireNativeAgentData(name, await nativeAgent.project.inbox.post({}, treatyOptions(headers, signal)));
  }
  if (name === 'project_inbox_ack') {
    return requireNativeAgentData(
      name,
      await nativeAgent.project.inbox.ack.post({ cursor: numberArg(args, 'cursor') }, treatyOptions(headers, signal))
    );
  }
  if (name === 'agent_send') {
    const text = stringArg(args, 'text');
    const attachments = attachmentsArg(args);
    return requireNativeAgentData(
      name,
      await nativeAgent.agent.send.post(
        {
          requestId: stringArg(args, 'requestId', true),
          to: stringArg(args, 'to', true),
          deliveryMode: deliveryModeArg(args),
          ...(text ? { text } : {}),
          ...(attachments ? { attachments } : {})
        },
        treatyOptions(headers, signal)
      )
    );
  }
  if (name === 'agent_read') {
    return requireNativeAgentData(
      name,
      await nativeAgent.agent.read.post(
        {
          with: stringArg(args, 'with', true),
          before: stringArg(args, 'before'),
          after: stringArg(args, 'after'),
          limit: numberArg(args, 'limit')
        },
        treatyOptions(headers, signal)
      )
    );
  }
  if (name === 'session_members') {
    return requireNativeAgentData(name, await nativeAgent.session.members.get(treatyOptions(headers, signal)));
  }
  if (name === 'runtime_info') {
    return requireNativeAgentData(name, await nativeAgent.runtime.info.get(treatyOptions(headers, signal)));
  }
  // Plan tools parse the raw arguments through the wire request schemas — which `.omit({ sessionId })` and
  // are `.strict()`, so a forged sessionId/actor/transport field can't even parse and never reaches the
  // route. The daemon derives the session + attribution from the bound runtime via requireManagedBinding.
  if (name === 'project_plan_list') {
    return requireNativeAgentData(name, await nativeAgent.project.plan.get(treatyOptions(headers, signal)));
  }
  if (name === 'project_plan_add') {
    const body = nativeAgentProjectPlanAddRequestSchema.parse(args);
    return requireNativeAgentData(
      name,
      await nativeAgent.project.plan.todos.post(body, treatyOptions(headers, signal))
    );
  }
  if (name === 'project_plan_update') {
    const body = nativeAgentProjectPlanUpdateRequestSchema.parse(args);
    return requireNativeAgentData(
      name,
      await nativeAgent.project.plan.todos.update.post(body, treatyOptions(headers, signal))
    );
  }
  if (name === 'project_plan_delete') {
    const body = nativeAgentProjectPlanDeleteRequestSchema.parse(args);
    return requireNativeAgentData(
      name,
      await nativeAgent.project.plan.todos.delete.post(body, treatyOptions(headers, signal))
    );
  }
  throw new Error(`unknown tool: ${name}`);
}

export function createAgentFacingMcpHandler(client: MonadClient) {
  const idempotency = new Map<string, unknown>();
  const order: string[] = [];
  const remember = (key: string, value: unknown): unknown => {
    if (!idempotency.has(key)) {
      idempotency.set(key, value);
      order.push(key);
      while (order.length > IDEMPOTENCY_CACHE_LIMIT) {
        const evicted = order.shift();
        if (evicted) idempotency.delete(evicted);
      }
    }
    return value;
  };

  const projectReadSnapshots = new Map<string, ProjectReadSnapshot>();
  let projectReadSnapshotBytes = 0;
  const deleteProjectReadSnapshot = (snapshotId: string): void => {
    const snapshot = projectReadSnapshots.get(snapshotId);
    if (!snapshot) return;
    projectReadSnapshots.delete(snapshotId);
    projectReadSnapshotBytes -= snapshot.totalBytes;
  };
  const pruneProjectReadSnapshots = (): void => {
    const expiresBefore = Date.now() - PROJECT_READ_SNAPSHOT_TTL_MS;
    for (const snapshot of projectReadSnapshots.values()) {
      if (snapshot.createdAt > expiresBefore) break;
      deleteProjectReadSnapshot(snapshot.id);
    }
  };
  const rememberProjectReadSnapshot = (data: unknown): ProjectReadSnapshot => {
    pruneProjectReadSnapshots();
    const bytes = textEncoder.encode(JSON.stringify(data, null, 2));
    const snapshot: ProjectReadSnapshot = Object.freeze({
      id: crypto.randomUUID(),
      bytes,
      totalBytes: bytes.byteLength,
      sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'),
      createdAt: Date.now()
    });
    projectReadSnapshots.set(snapshot.id, snapshot);
    projectReadSnapshotBytes += snapshot.totalBytes;
    while (
      projectReadSnapshots.size > 1 &&
      (projectReadSnapshots.size > PROJECT_READ_SNAPSHOT_LIMIT ||
        projectReadSnapshotBytes > PROJECT_READ_SNAPSHOT_BYTES)
    ) {
      const oldest = projectReadSnapshots.keys().next().value;
      if (typeof oldest !== 'string') break;
      deleteProjectReadSnapshot(oldest);
    }
    return snapshot;
  };
  const unavailableProjectReadCursor = (): never => {
    throw new Error(
      'project_read cursor expired, was evicted, or is invalid; call project_read again without cursor to create a new snapshot'
    );
  };
  const parseProjectReadCursor = (cursor: string): { snapshot: ProjectReadSnapshot; offset: number } => {
    pruneProjectReadSnapshots();
    const separator = cursor.lastIndexOf(':');
    if (separator <= 0) return unavailableProjectReadCursor();
    const snapshot = projectReadSnapshots.get(cursor.slice(0, separator));
    const offset = Number(cursor.slice(separator + 1));
    if (
      !snapshot ||
      !Number.isSafeInteger(offset) ||
      offset <= 0 ||
      offset >= snapshot.totalBytes ||
      utf8BoundaryAtOrBefore(snapshot.bytes, offset) !== offset
    ) {
      return unavailableProjectReadCursor();
    }
    return { snapshot, offset };
  };
  const projectReadChunkResult = (snapshot: ProjectReadSnapshot, offset: number, id: JsonRpcId): ToolSuccess => {
    const resultAt = (end: number): ToolSuccess => {
      const complete = end === snapshot.totalBytes;
      return toolResult({
        encoding: 'json-utf8-chunks',
        snapshotId: snapshot.id,
        chunk: textDecoder.decode(snapshot.bytes.subarray(offset, end)),
        offsetBytes: offset,
        returnedBytes: end - offset,
        totalBytes: snapshot.totalBytes,
        sha256: snapshot.sha256,
        complete,
        ...(complete ? {} : { nextCursor: `${snapshot.id}:${end}` })
      });
    };
    const complete = resultAt(snapshot.totalBytes);
    if (jsonRpcLineBytes(id, complete) <= MAX_JSON_RPC_LINE_BYTES) return complete;

    let low = offset + 1;
    let high = snapshot.totalBytes - 1;
    let best = offset;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const end = utf8BoundaryAtOrBefore(snapshot.bytes, middle);
      if (end <= best) {
        low = middle + 1;
        continue;
      }
      if (jsonRpcLineBytes(id, resultAt(end)) <= MAX_JSON_RPC_LINE_BYTES) {
        best = end;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (best === offset) {
      throw new Error('project_read response metadata exceeds the maximum JSON-RPC line size');
    }
    return resultAt(best);
  };

  type InFlightToolCall = {
    toolName: string;
    requestId?: string;
    controller: AbortController;
    deadline: ReturnType<typeof setTimeout>;
    cancelled?: true;
    reconciliation?: Promise<void>;
  };
  const inFlight = new Map<string, InFlightToolCall>();
  const reconciliations = new Set<Promise<void>>();
  const callKey = (id: JsonRpcId): string => `${typeof id}:${String(id)}`;
  const deadlineFor = (name: string, args: Record<string, unknown>): number => {
    if (name !== 'project_ask' || booleanArg(args, 'blocking', false)) return TOOL_CALL_DEADLINE_MS;
    return (
      (numberArg(args, 'autoResolutionMs') ?? DEFAULT_NON_BLOCKING_PROJECT_ASK_AUTO_RESOLUTION_MS) +
      PROJECT_ASK_DEADLINE_GRACE_MS
    );
  };

  const reconcileCancellation = async (
    entry: Pick<InFlightToolCall, 'requestId'> & { requestId: string },
    cause: 'timeout' | 'cancelled' | 'transport_eof'
  ): Promise<void> => {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort('timeout'), PROJECT_ASK_RECONCILIATION_TIMEOUT_MS);
    try {
      await nativeAgentProjectAsk(client).ask.cancel.post(
        { requestId: entry.requestId, cause },
        treatyOptions(runtimeHeaders(), controller.signal)
      );
    } finally {
      clearTimeout(deadline);
      controller.abort('settled');
    }
  };

  const trackReconciliation = (reconciliation: Promise<void>): Promise<void> => {
    reconciliations.add(reconciliation);
    void reconciliation.then(
      () => reconciliations.delete(reconciliation),
      () => reconciliations.delete(reconciliation)
    );
    return reconciliation;
  };

  const cancelInFlight = (entry: InFlightToolCall, cause: 'timeout' | 'cancelled' | 'transport_eof'): void => {
    if (entry.cancelled) return;
    entry.cancelled = true;
    entry.controller.abort(cause);
    if (entry.toolName === 'project_ask' && entry.requestId) {
      entry.reconciliation = trackReconciliation(
        reconcileCancellation(entry as InFlightToolCall & { requestId: string }, cause)
      );
    }
  };

  const handleToolCall = async (params: ToolCallParams, id: JsonRpcId, signal?: AbortSignal): Promise<unknown> => {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = objectArgs(params.arguments);
    if (!tools.some((tool) => tool.name === name)) throw new Error(`unknown tool: ${name}`);
    const requestId = stringArg(args, 'requestId');
    const idempotencyScope = requestId && DAEMON_FINGERPRINTED_TOOLS.has(name) ? `:${stableStringify(args)}` : '';
    const key = requestId ? `${name}:${requestId}${idempotencyScope}` : '';
    if (MUTATING_TOOLS.has(name) && !key) throw new Error(`${name} requires requestId for idempotency`);
    if (key && idempotency.has(key)) return idempotency.get(key);
    try {
      if (name === 'project_read') {
        const cursor = stringArg(args, 'cursor');
        if (cursor) {
          const { snapshot, offset } = parseProjectReadCursor(cursor);
          return projectReadChunkResult(snapshot, offset, id);
        }
      }
      const data = await callTool(client, name, args, signal);
      const result = toolResult(data);
      if (name === 'project_read' && jsonRpcLineBytes(id, result) > MAX_JSON_RPC_LINE_BYTES) {
        return projectReadChunkResult(rememberProjectReadSnapshot(data), 0, id);
      }
      return key ? remember(key, result) : result;
    } catch (error) {
      logNativeAgentMcpError(name, error);
      const result = toolError(error);
      // Tools with a durable daemon idempotency ledger must not cache a transient failure: a first attempt
      // that fails before the daemon commits, or after commit with a lost response, has to reach the ledger
      // again on retry (re-do or replay) — caching the error here would pin the same requestId to a
      // permanent failure. Messaging tools have no ledger, so their error cache stays the double-send guard.
      const cacheError = !DAEMON_FINGERPRINTED_TOOLS.has(name);
      return key && cacheError ? remember(key, result) : result;
    }
  };

  const dispatchToolCall = async (
    params: ToolCallParams,
    id: JsonRpcId,
    externalSignal?: AbortSignal
  ): Promise<unknown> => {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = objectArgs(params.arguments);
    const requestId = stringArg(args, 'requestId');
    const controller = new AbortController();
    const entry: InFlightToolCall = {
      toolName: name,
      ...(requestId ? { requestId } : {}),
      controller,
      deadline: undefined as never
    };
    const onExternalAbort = (): void => {
      cancelInFlight(
        entry,
        /time(?:d)?\s*out|deadline/i.test(String(externalSignal?.reason)) ? 'timeout' : 'cancelled'
      );
    };
    entry.deadline = setTimeout(
      () => {
        void cancelInFlight(entry, 'timeout');
      },
      deadlineFor(name, args)
    );
    inFlight.set(callKey(id), entry);
    if (externalSignal?.aborted) onExternalAbort();
    else externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    try {
      return await handleToolCall(params, id, controller.signal);
    } finally {
      externalSignal?.removeEventListener('abort', onExternalAbort);
      clearTimeout(entry.deadline);
      inFlight.delete(callKey(id));
    }
  };

  return {
    listTools(): ToolDef[] {
      return tools;
    },
    callTool(params: ToolCallParams, id: JsonRpcId, signal?: AbortSignal): Promise<unknown> {
      return dispatchToolCall(params, id, signal);
    },
    async handle(request: JsonRpcRequest, signal?: AbortSignal): Promise<JsonRpcResponse | null> {
      const id = request.id ?? null;
      try {
        if (request.method === 'initialize') {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: 'monad-native-agent', version: '0.0.0' }
            }
          };
        }
        if (request.method === 'notifications/initialized') return null;
        if (request.method === 'notifications/cancelled') {
          const params = objectArgs(request.params);
          const cancelledId = params.requestId;
          if (typeof cancelledId !== 'string' && typeof cancelledId !== 'number') return null;
          const entry = inFlight.get(callKey(cancelledId));
          if (!entry) return null;
          const reason = typeof params.reason === 'string' ? params.reason : '';
          cancelInFlight(entry, /time(?:d)?\s*out|deadline/i.test(reason) ? 'timeout' : 'cancelled');
          return null;
        }
        if (request.method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools } };
        if (request.method === 'tools/call') {
          return { jsonrpc: '2.0', id, result: await dispatchToolCall(objectArgs(request.params), id, signal) };
        }
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${request.method}` } };
      } catch (error) {
        if (request.method === 'tools/call') return { jsonrpc: '2.0', id, result: toolError(error) };
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: error instanceof Error ? error.message : String(error) }
        };
      }
    },
    async close(): Promise<void> {
      const entries = [...inFlight.values()];
      entries.forEach((entry) => {
        clearTimeout(entry.deadline);
        cancelInFlight(entry, 'transport_eof');
      });
      await Promise.allSettled([...reconciliations]);
    }
  };
}

export function createAgentFacingProtocolServer(handler: ReturnType<typeof createAgentFacingMcpHandler>): Server {
  const server = new Server(
    { name: 'monad-native-agent', version: '0.0.0' },
    {
      capabilities: { tools: {} },
      cacheHints: {
        'server/discover': { ttlMs: 0, cacheScope: 'private' },
        'tools/list': { ttlMs: 0, cacheScope: 'private' }
      }
    }
  );
  server.setRequestHandler('tools/list', async () => ({ tools: handler.listTools() }));
  server.setRequestHandler('tools/call', async (request, context) => {
    return (await handler.callTool(request.params, context.mcpReq.id, context.mcpReq.signal)) as CallToolResult;
  });
  return server;
}

export async function serveAgentFacingMcpStdio(client: MonadClient): Promise<void> {
  const handler = createAgentFacingMcpHandler(client);
  const serverHandle = serveStdio(() => createAgentFacingProtocolServer(handler), { legacy: 'serve' });
  try {
    await new Promise<void>((resolve, reject) => {
      if (process.stdin.readableEnded) {
        resolve();
        return;
      }
      process.stdin.once('end', resolve);
      process.stdin.once('error', reject);
    });
  } finally {
    await handler.close();
    await serverHandle.close();
  }
}
