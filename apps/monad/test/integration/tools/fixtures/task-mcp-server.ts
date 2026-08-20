const encoder = new TextEncoder();
const decoder = new TextDecoder();
const serverInfo = { name: 'task-fixture', version: '0.0.0' };
let buffer = '';
let inputAccepted = false;

for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  while (true) {
    const newline = buffer.indexOf('\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const request = JSON.parse(line) as {
      id?: string | number;
      method: string;
      params?: Record<string, unknown>;
    };
    if (request.id === undefined) continue;
    await Bun.write(Bun.stdout, encoder.encode(`${JSON.stringify(responseFor(request))}\n`));
  }
}

function responseFor(request: {
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}): Record<string, unknown> {
  const base = { jsonrpc: '2.0', id: request.id };
  if (request.method === 'server/discover') {
    return {
      ...base,
      result: {
        supportedVersions: ['2026-07-28'],
        capabilities: {
          tools: {},
          extensions: { 'io.modelcontextprotocol/tasks': {} }
        },
        resultType: 'complete',
        ttlMs: 0,
        cacheScope: 'private',
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo }
      }
    };
  }
  if (request.method === 'tools/list') {
    return {
      ...base,
      result: {
        tools: [
          {
            name: 'delegate',
            description: 'delegate through a native MCP task',
            inputSchema: {
              type: 'object',
              properties: { prompt: { type: 'string' } },
              required: ['prompt']
            }
          }
        ],
        resultType: 'complete',
        ttlMs: 0,
        cacheScope: 'private',
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo }
      }
    };
  }
  if (request.method === 'tools/call') {
    return {
      ...base,
      result: {
        resultType: 'task',
        taskId: 'task_native_1',
        status: 'working',
        statusMessage: 'Delegating',
        createdAt: '2026-07-31T00:00:00.000Z',
        lastUpdatedAt: '2026-07-31T00:00:00.000Z',
        ttlMs: null,
        pollIntervalMs: 0
      }
    };
  }
  if (request.method === 'tasks/get') {
    return {
      ...base,
      result: inputAccepted
        ? {
            resultType: 'complete',
            taskId: 'task_native_1',
            status: 'completed',
            createdAt: '2026-07-31T00:00:00.000Z',
            lastUpdatedAt: '2026-07-31T00:01:00.000Z',
            ttlMs: null,
            result: {
              resultType: 'complete',
              content: [{ type: 'text', text: 'Production deployed' }],
              structuredContent: { environment: 'Production' }
            }
          }
        : {
            resultType: 'complete',
            taskId: 'task_native_1',
            status: 'input_required',
            createdAt: '2026-07-31T00:00:00.000Z',
            lastUpdatedAt: '2026-07-31T00:00:30.000Z',
            ttlMs: null,
            pollIntervalMs: 0,
            inputRequests: {
              environment: {
                method: 'elicitation/create',
                params: {
                  mode: 'form',
                  message: 'Which environment?',
                  requestedSchema: {
                    type: 'object',
                    properties: {
                      answer: { type: 'string', title: 'Environment', enum: ['Staging', 'Production'] }
                    },
                    required: ['answer']
                  }
                }
              }
            }
          }
    };
  }
  if (request.method === 'tasks/update') {
    inputAccepted = true;
    return { ...base, result: { resultType: 'complete' } };
  }
  if (request.method === 'tasks/cancel') {
    return { ...base, result: { resultType: 'complete' } };
  }
  return { ...base, error: { code: -32601, message: `Method not found: ${request.method}` } };
}
