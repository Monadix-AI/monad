import type { MonadClient } from '@monad/client';

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

type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type TreatyResult<T> = { data: T | null; error?: unknown; status: number };

const PROTOCOL_VERSION = '2025-06-18';
const MUTATING_TOOLS = new Set(['project_post', 'project_ask', 'agent_send']);
const IDEMPOTENCY_CACHE_LIMIT = 256;

function runtimeHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (Bun.env.MONAD_MESH_SESSION_ID) headers['x-monad-mesh-session-id'] = Bun.env.MONAD_MESH_SESSION_ID;
  return headers;
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

function toolResult(data: unknown): { content: Array<{ type: 'text'; text: string }>; isError: false } {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError: false };
}

function toolError(error: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: message }], isError: true };
}

function treatyErrorMessage(error: unknown): string {
  if (!error) return '';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (typeof error === 'object') {
    const record = error as Record<string, unknown>;
    for (const key of ['value', 'body', 'response']) {
      const nested = treatyErrorMessage(record[key]);
      if (nested) return nested;
    }
    if (typeof record.message === 'string') return record.message;
    if (typeof record.error === 'string') {
      return typeof record.code === 'string' ? `${record.code}: ${record.error}` : record.error;
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

function schema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

const requestIdProperty = {
  type: 'string',
  description: 'Stable idempotency key for this intended side effect. Reuse it when retrying the same action.'
};

const tools: ToolDef[] = [
  {
    name: 'project_post',
    description: 'Post a public message to the current Workplace Project transcript.',
    inputSchema: schema(
      {
        requestId: requestIdProperty,
        text: { type: 'string' },
        threadId: { type: 'string' },
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
    description: 'Ask the human operator a single-choice or multiple-choice question and wait for the answer.',
    inputSchema: schema(
      {
        requestId: requestIdProperty,
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' } },
        mode: { type: 'string', enum: ['single', 'multiple'] },
        allowOther: { type: 'boolean' }
      },
      ['requestId', 'question']
    )
  },
  {
    name: 'project_read',
    description: 'Read recent Workplace Project messages or a bounded window around a message.',
    inputSchema: schema({
      threadId: { type: 'string' },
      before: { type: 'string' },
      after: { type: 'string' },
      around: { type: 'string' },
      limit: { type: 'number' }
    })
  },
  {
    name: 'project_inbox_check',
    description: 'Read pending project inbox items for this managed MeshAgent.',
    inputSchema: schema({})
  },
  {
    name: 'project_inbox_ack',
    description: 'Advance the visible inbox cursor for this managed MeshAgent.',
    inputSchema: schema({ cursor: { type: 'number' } })
  },
  {
    name: 'agent_send',
    description:
      'Send a private direct message to another Monad agent or human. This does not enter the project transcript.',
    inputSchema: schema(
      {
        requestId: requestIdProperty,
        to: { type: 'string' },
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
    description: 'Read private direct conversation history with another Monad agent or human.',
    inputSchema: schema(
      { with: { type: 'string' }, before: { type: 'string' }, after: { type: 'string' }, limit: { type: 'number' } },
      ['with']
    )
  },
  {
    name: 'runtime_info',
    description: 'Show the current managed MeshAgent runtime binding.',
    inputSchema: schema({})
  }
];

function nativeAgentProjectAsk(client: MonadClient) {
  return client.treaty.v1.internal['native-agent']
    .project as (typeof client.treaty.v1.internal)['native-agent']['project'] & {
    ask: {
      post: (
        body: unknown,
        options?: { headers?: Record<string, string> }
      ) => Promise<{ data: unknown | null; status: number }>;
    };
  };
}

async function callTool(client: MonadClient, name: string, args: Record<string, unknown>): Promise<unknown> {
  const headers = runtimeHeaders();
  const nativeAgent = client.treaty.v1.internal['native-agent'];
  if (name === 'project_post') {
    const text = stringArg(args, 'text');
    const attachments = attachmentsArg(args);
    return requireNativeAgentData(
      name,
      await nativeAgent.project.post.post(
        {
          threadId: stringArg(args, 'threadId'),
          ...(text ? { text } : {}),
          ...(attachments ? { attachments } : {})
        },
        { headers }
      )
    );
  }
  if (name === 'project_ask') {
    return requireNativeAgentData(
      name,
      await nativeAgentProjectAsk(client).ask.post(
        {
          question: stringArg(args, 'question', true),
          options: stringArrayArg(args, 'options'),
          mode: stringArg(args, 'mode') === 'multiple' ? 'multiple' : 'single',
          allowOther: booleanArg(args, 'allowOther', true)
        },
        { headers }
      )
    );
  }
  if (name === 'project_read') {
    return requireNativeAgentData(
      name,
      await nativeAgent.project.read.post(
        {
          threadId: stringArg(args, 'threadId'),
          before: stringArg(args, 'before'),
          after: stringArg(args, 'after'),
          around: stringArg(args, 'around'),
          limit: numberArg(args, 'limit')
        },
        { headers }
      )
    );
  }
  if (name === 'project_inbox_check') {
    return requireNativeAgentData(name, await nativeAgent.project.inbox.post({}, { headers }));
  }
  if (name === 'project_inbox_ack') {
    return requireNativeAgentData(
      name,
      await nativeAgent.project.inbox.ack.post({ cursor: numberArg(args, 'cursor') }, { headers })
    );
  }
  if (name === 'agent_send') {
    const text = stringArg(args, 'text');
    const attachments = attachmentsArg(args);
    return requireNativeAgentData(
      name,
      await nativeAgent.agent.send.post(
        {
          to: stringArg(args, 'to', true),
          ...(text ? { text } : {}),
          ...(attachments ? { attachments } : {})
        },
        { headers }
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
        { headers }
      )
    );
  }
  if (name === 'runtime_info') {
    return requireNativeAgentData(name, await nativeAgent.runtime.info.get({ headers }));
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

  const handleToolCall = async (params: ToolCallParams): Promise<unknown> => {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = objectArgs(params.arguments);
    if (!tools.some((tool) => tool.name === name)) throw new Error(`unknown tool: ${name}`);
    const requestId = stringArg(args, 'requestId');
    const key = requestId ? `${name}:${requestId}` : '';
    if (MUTATING_TOOLS.has(name) && !key) throw new Error(`${name} requires requestId for idempotency`);
    if (key && idempotency.has(key)) return idempotency.get(key);
    try {
      const result = toolResult(await callTool(client, name, args));
      return key ? remember(key, result) : result;
    } catch (error) {
      logNativeAgentMcpError(name, error);
      throw error;
    }
  };

  return {
    async handle(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
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
        if (request.method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools } };
        if (request.method === 'tools/call') {
          return { jsonrpc: '2.0', id, result: await handleToolCall(objectArgs(request.params)) };
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
    }
  };
}

export async function serveAgentFacingMcpStdio(client: MonadClient): Promise<void> {
  const handler = createAgentFacingMcpHandler(client);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(line) as JsonRpcRequest;
      } catch {
        await Bun.write(
          Bun.stdout,
          encoder.encode(
            `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`
          )
        );
        continue;
      }
      const response = await handler.handle(request);
      if (response) await Bun.write(Bun.stdout, encoder.encode(`${JSON.stringify(response)}\n`));
    }
  }
}
