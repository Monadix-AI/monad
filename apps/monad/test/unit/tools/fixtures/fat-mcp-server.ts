// Stdio MCP server with 50 tools — each tool has a long description so the
// combined schema size crosses the tool_search deferred-mode token threshold.
// Used by tool-search-deferred-mcp.test.ts.

const encoder = new TextEncoder();
function reply(obj: unknown): void {
  Bun.write(Bun.stdout, encoder.encode(`${JSON.stringify(obj)}\n`));
}

const TOOL_COUNT = 50;
const tools = Array.from({ length: TOOL_COUNT }, (_, i) => ({
  name: `tool_${i}`,
  description: `Performs operation ${i}. ${'This tool handles a specific category of tasks related to data processing, transformation, and output formatting. '.repeat(6)}`,
  inputSchema: {
    type: 'object',
    properties: {
      input: { type: 'string', description: `The input value for operation ${i}` },
      options: { type: 'object', description: 'Optional configuration parameters' }
    }
  }
}));

const decoder = new TextDecoder();
let buf = '';
for await (const chunk of Bun.stdin.stream()) {
  buf += decoder.decode(chunk, { stream: true });
  for (let nl = buf.indexOf('\n'); nl !== -1; nl = buf.indexOf('\n')) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line) as { id?: number; method: string; params?: unknown };
    switch (msg.method) {
      case 'initialize':
        reply({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'fat', version: '0.0.0' }
          }
        });
        break;
      case 'notifications/initialized':
        break;
      case 'tools/list':
        reply({ jsonrpc: '2.0', id: msg.id, result: { tools } });
        break;
      case 'tools/call': {
        const params = msg.params as { name: string; arguments: { input?: string } };
        reply({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [{ type: 'text', text: `fat:${params.name}:${params.arguments?.input ?? ''}` }],
            isError: false
          }
        });
        break;
      }
      default:
        reply({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown: ${msg.method}` } });
    }
  }
}
