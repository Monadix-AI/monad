import { acceptedContent, inputRequired, McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

serveStdio(
  () => {
    const server = new McpServer(
      { name: 'modern-fixture', version: '0.0.0' },
      {
        cacheHints: { 'tools/list': { ttlMs: 1_000, cacheScope: 'private' } }
      }
    );
    server.registerTool(
      'echo',
      {
        description: 'echo text',
        inputSchema: z.object({ text: z.string() }),
        outputSchema: z.object({ echoed: z.string() })
      },
      async ({ text }, ctx) => {
        const progressToken = ctx.mcpReq._meta?.progressToken ?? ctx.mcpReq.id;
        await ctx.mcpReq.notify({
          method: 'notifications/progress',
          params: { progressToken, progress: 1, total: 1, message: 'Echo ready' }
        });
        return {
          content: [{ type: 'text', text }],
          structuredContent: { echoed: text },
          isError: false
        };
      }
    );
    server.registerTool(
      'interactive',
      {
        description: 'ask for a value',
        inputSchema: z.object({}),
        outputSchema: z.object({ answer: z.string() })
      },
      async (_args, ctx) => {
        const response = acceptedContent(ctx.mcpReq.inputResponses, 'answer', z.object({ value: z.string() }));
        if (!response) {
          return inputRequired({
            inputRequests: {
              answer: inputRequired.elicit({
                message: 'What should the provider use?',
                requestedSchema: {
                  type: 'object',
                  properties: { value: { type: 'string' } },
                  required: ['value']
                }
              })
            }
          });
        }
        return {
          content: [{ type: 'text', text: response.value }],
          structuredContent: { answer: response.value }
        };
      }
    );
    server.registerTool(
      'slow',
      {
        description: 'wait until cancelled',
        inputSchema: z.object({}),
        outputSchema: z.object({ cancelled: z.boolean() })
      },
      async (_args, ctx) => {
        await new Promise<void>((_resolve, reject) => {
          ctx.mcpReq.signal.addEventListener(
            'abort',
            () => reject(new DOMException('cancelled by client', 'AbortError')),
            { once: true }
          );
        });
        return {
          content: [{ type: 'text', text: 'completed without cancellation' }],
          structuredContent: { cancelled: false }
        };
      }
    );
    return server;
  },
  { legacy: 'reject' }
);
