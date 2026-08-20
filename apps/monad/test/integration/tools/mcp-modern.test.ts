import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { connectMcpServer } from '#/capabilities/tools';

const fixture = join(import.meta.dir, 'fixtures', 'modern-mcp-server.ts');
test('connectMcpServer negotiates modern-only MCP and preserves structured tool output', async () => {
  const connection = await connectMcpServer({ name: 'modern', command: 'bun', args: [fixture] });
  try {
    expect(connection.tools.map((tool) => tool.name)).toEqual(['modern__echo', 'modern__interactive', 'modern__slow']);
    expect(await connection.callTool('echo', { text: 'direct' })).toEqual([{ type: 'text', text: 'direct' }]);

    const progress: string[] = [];
    const ctx = {
      sessionId: 's1',
      sandboxRoots: undefined,
      log: () => {},
      reportProgress: (output: string) => progress.push(output)
    };
    const output = await connection.tools[0]?.run({ text: 'wrapped' }, ctx);
    expect(output).toEqual({
      metadata: {
        protocolVersion: '2026-07-28',
        protocolEra: 'modern',
        text: 'wrapped\n{"echoed":"wrapped"}',
        structuredContent: { echoed: 'wrapped' },
        imageCount: 0
      },
      modelContent: [{ type: 'text', text: 'wrapped\n{"echoed":"wrapped"}' }]
    });
    expect(progress).toEqual(['Echo ready']);
    expect(connection.tools[0]?.inputSchema?.toJsonSchema?.()).toEqual({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text']
    });

    const questions: string[] = [];
    const interactive = await connection.tools[1]?.run(
      {},
      {
        sessionId: 's1',
        log: () => {},
        ask: async ({ question }) => {
          questions.push(question);
          return { answer: JSON.stringify({ value: 'ship it' }), status: 'answered' as const };
        }
      }
    );
    expect(questions).toEqual(['What should the provider use?']);
    expect(interactive).toEqual({
      metadata: {
        protocolVersion: '2026-07-28',
        protocolEra: 'modern',
        text: 'ship it\n{"answer":"ship it"}',
        structuredContent: { answer: 'ship it' },
        imageCount: 0
      },
      modelContent: [{ type: 'text', text: 'ship it\n{"answer":"ship it"}' }]
    });

    const controller = new AbortController();
    const cancelled = connection.tools[2]?.run({}, { sessionId: 's1', log: () => {}, signal: controller.signal });
    controller.abort();
    await expect(cancelled).rejects.toThrow();
  } finally {
    await connection.close();
  }
});
