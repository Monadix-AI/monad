import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { connectMcpServer } from '#/capabilities/tools';

const fixture = join(import.meta.dir, 'fixtures', 'task-mcp-server.ts');

function taskHttpServer(handle: (rpc: { id: string | number; method: string }) => Response | Promise<Response>): {
  server: ReturnType<typeof Bun.serve>;
  methods: string[];
} {
  const methods: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const rpc = (await request.json()) as { id: string | number; method: string };
      methods.push(rpc.method);
      const base = { jsonrpc: '2.0', id: rpc.id };
      if (rpc.method === 'server/discover') {
        return Response.json({
          ...base,
          result: {
            supportedVersions: ['2026-07-28'],
            capabilities: { tools: {}, extensions: { 'io.modelcontextprotocol/tasks': {} } },
            resultType: 'complete',
            ttlMs: 0,
            cacheScope: 'private',
            _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'task-http', version: '0.0.0' } }
          }
        });
      }
      if (rpc.method === 'tools/list') {
        return Response.json({
          ...base,
          result: {
            tools: [{ name: 'delegate', inputSchema: { type: 'object' } }],
            resultType: 'complete',
            ttlMs: 0,
            cacheScope: 'private',
            _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'task-http', version: '0.0.0' } }
          }
        });
      }
      return handle(rpc);
    }
  });
  return { server, methods };
}

test('connectMcpServer drives a native MCP task through input_required to completion', async () => {
  const connection = await connectMcpServer({ name: 'tasks', command: 'bun', args: [fixture] });
  try {
    const questions: Array<{ question: string; options?: Array<{ label: string; value: string }> }> = [];
    const progress: string[] = [];
    const output = await connection.tools[0]?.run(
      { prompt: 'Deploy' },
      {
        sessionId: 's1',
        log: () => {},
        reportProgress: (message) => progress.push(message),
        ask: async ({ question, form }) => {
          questions.push({ question, options: form?.fields[0]?.options });
          return { answer: JSON.stringify({ answer: 'Production' }), status: 'answered' as const };
        }
      }
    );

    expect({ questions, progress, output }).toEqual({
      questions: [
        {
          question: 'Which environment?',
          options: [
            { label: 'Staging', value: 'Staging' },
            { label: 'Production', value: 'Production' }
          ]
        }
      ],
      progress: [
        {
          type: 'mcp_task',
          server: 'tasks',
          tool: 'delegate',
          taskId: 'task_native_1',
          status: 'working',
          statusMessage: 'Delegating',
          createdAt: '2026-07-31T00:00:00.000Z',
          lastUpdatedAt: '2026-07-31T00:00:00.000Z',
          pollIntervalMs: 0
        },
        {
          type: 'mcp_task',
          server: 'tasks',
          tool: 'delegate',
          taskId: 'task_native_1',
          status: 'input_required',
          createdAt: '2026-07-31T00:00:00.000Z',
          lastUpdatedAt: '2026-07-31T00:00:30.000Z',
          pollIntervalMs: 0
        },
        {
          type: 'mcp_task',
          server: 'tasks',
          tool: 'delegate',
          taskId: 'task_native_1',
          status: 'completed',
          createdAt: '2026-07-31T00:00:00.000Z',
          lastUpdatedAt: '2026-07-31T00:01:00.000Z'
        }
      ].map((item) => JSON.stringify(item)),
      output: {
        metadata: {
          protocolVersion: '2026-07-28',
          protocolEra: 'modern',
          text: 'Production deployed\n{"environment":"Production"}',
          structuredContent: { environment: 'Production' },
          taskId: 'task_native_1',
          taskExtension: 'io.modelcontextprotocol/tasks',
          imageCount: 0
        },
        modelContent: [{ type: 'text', text: 'Production deployed\n{"environment":"Production"}' }]
      }
    });
  } finally {
    await connection.close();
  }
});

test('connectMcpServer consumes notifications/tasks before the next poll', async () => {
  const methods: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const rpc = (await request.json()) as {
        id: string | number;
        method: string;
      };
      methods.push(rpc.method);
      const base = { jsonrpc: '2.0', id: rpc.id };
      if (rpc.method === 'server/discover') {
        return Response.json({
          ...base,
          result: {
            supportedVersions: ['2026-07-28'],
            capabilities: { tools: {}, extensions: { 'io.modelcontextprotocol/tasks': {} } },
            resultType: 'complete',
            ttlMs: 0,
            cacheScope: 'private',
            _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'task-http', version: '0.0.0' } }
          }
        });
      }
      if (rpc.method === 'tools/list') {
        return Response.json({
          ...base,
          result: {
            tools: [{ name: 'delegate', inputSchema: { type: 'object' } }],
            resultType: 'complete',
            ttlMs: 0,
            cacheScope: 'private',
            _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'task-http', version: '0.0.0' } }
          }
        });
      }
      if (rpc.method === 'tools/call') {
        return Response.json({
          ...base,
          result: {
            resultType: 'task',
            taskId: 'task_http_1',
            status: 'working',
            statusMessage: 'Delegating',
            createdAt: '2026-07-31T00:00:00.000Z',
            lastUpdatedAt: '2026-07-31T00:00:00.000Z',
            ttlMs: null,
            pollIntervalMs: 30_000
          }
        });
      }
      if (rpc.method === 'subscriptions/listen') {
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `event: message\ndata: ${JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'notifications/subscriptions/acknowledged',
                    params: { notifications: { taskIds: ['task_http_1'] } }
                  })}\n\n`
                )
              );
              controller.enqueue(
                encoder.encode(
                  `event: message\ndata: ${JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'notifications/tasks',
                    params: {
                      taskId: 'task_http_1',
                      status: 'completed',
                      statusMessage: 'Deployed',
                      createdAt: '2026-07-31T00:00:00.000Z',
                      lastUpdatedAt: '2026-07-31T00:00:01.000Z',
                      ttlMs: null,
                      pollIntervalMs: 0,
                      result: {
                        content: [{ type: 'text', text: 'Done' }],
                        structuredContent: { environment: 'Production' }
                      }
                    }
                  })}\n\n`
                )
              );
              controller.close();
            }
          }),
          { headers: { 'content-type': 'text/event-stream' } }
        );
      }
      return Response.json({ ...base, error: { code: -32601, message: 'Method not found' } });
    }
  });
  const connection = await connectMcpServer({
    name: 'tasks-http',
    transport: 'http',
    url: server.url.toString()
  });
  try {
    const output = await connection.tools[0]?.run(
      {},
      {
        sessionId: 's-http',
        toolCallId: 'call-http',
        log: () => {}
      }
    );

    expect({ methods, output }).toEqual({
      methods: ['server/discover', 'tools/list', 'tools/call', 'subscriptions/listen'],
      output: {
        metadata: {
          protocolVersion: '2026-07-28',
          protocolEra: 'modern',
          text: 'Done\n{"environment":"Production"}',
          structuredContent: { environment: 'Production' },
          taskId: 'task_http_1',
          taskExtension: 'io.modelcontextprotocol/tasks',
          imageCount: 0
        },
        modelContent: [{ type: 'text', text: 'Done\n{"environment":"Production"}' }]
      }
    });
  } finally {
    await connection.close();
    server.stop(true);
  }
}, 5_000);

test('connectMcpServer retries a transient tasks/get failure', async () => {
  let getAttempts = 0;
  const { server, methods } = taskHttpServer((rpc) => {
    const base = { jsonrpc: '2.0', id: rpc.id };
    if (rpc.method === 'tools/call') {
      return Response.json({
        ...base,
        result: {
          resultType: 'task',
          taskId: 'task_retry_1',
          status: 'working',
          createdAt: '2026-07-31T00:00:00.000Z',
          lastUpdatedAt: '2026-07-31T00:00:00.000Z',
          ttlMs: null,
          pollIntervalMs: 0
        }
      });
    }
    if (rpc.method === 'subscriptions/listen') {
      return Response.json({ ...base, error: { code: -32601, message: 'Subscriptions unavailable' } });
    }
    if (rpc.method === 'tasks/get') {
      getAttempts += 1;
      if (getAttempts === 1) {
        return Response.json({ ...base, error: { code: -32603, message: 'Temporary failure' } });
      }
      return Response.json({
        ...base,
        result: {
          taskId: 'task_retry_1',
          status: 'completed',
          createdAt: '2026-07-31T00:00:00.000Z',
          lastUpdatedAt: '2026-07-31T00:00:01.000Z',
          ttlMs: null,
          result: { content: [{ type: 'text', text: 'Recovered' }] }
        }
      });
    }
    return Response.json({ ...base, error: { code: -32601, message: 'Method not found' } });
  });
  const connection = await connectMcpServer({
    name: 'tasks-retry',
    transport: 'http',
    url: server.url.toString()
  });
  try {
    const output = await connection.tools[0]?.run({}, { sessionId: 's-retry', log: () => {} });
    expect({ methods, text: (output?.metadata as { text?: unknown } | undefined)?.text }).toEqual({
      methods: ['server/discover', 'tools/list', 'tools/call', 'subscriptions/listen', 'tasks/get', 'tasks/get'],
      text: 'Recovered'
    });
  } finally {
    await connection.close();
    server.stop(true);
  }
}, 5_000);

test('connectMcpServer propagates cancellation to the remote task', async () => {
  const { server, methods } = taskHttpServer((rpc) => {
    const base = { jsonrpc: '2.0', id: rpc.id };
    if (rpc.method === 'tools/call') {
      return Response.json({
        ...base,
        result: {
          resultType: 'task',
          taskId: 'task_cancel_1',
          status: 'working',
          createdAt: '2026-07-31T00:00:00.000Z',
          lastUpdatedAt: '2026-07-31T00:00:00.000Z',
          ttlMs: null,
          pollIntervalMs: 30_000
        }
      });
    }
    if (rpc.method === 'subscriptions/listen') {
      return Response.json({ ...base, error: { code: -32601, message: 'Subscriptions unavailable' } });
    }
    if (rpc.method === 'tasks/cancel') {
      return Response.json({ ...base, result: { resultType: 'complete' } });
    }
    return Response.json({ ...base, error: { code: -32601, message: 'Method not found' } });
  });
  const connection = await connectMcpServer({
    name: 'tasks-cancel',
    transport: 'http',
    url: server.url.toString()
  });
  try {
    const abort = new AbortController();
    const run = connection.tools[0]?.run(
      {},
      {
        sessionId: 's-cancel',
        signal: abort.signal,
        log: () => {},
        reportProgress: () => abort.abort()
      }
    );
    await expect(run).rejects.toThrow();
    expect(methods).toEqual(['server/discover', 'tools/list', 'tools/call', 'subscriptions/listen', 'tasks/cancel']);
  } finally {
    await connection.close();
    server.stop(true);
  }
}, 5_000);
