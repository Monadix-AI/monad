// Minimal stdio MCP server for testing connectMcpServer. Speaks newline-delimited
// JSON-RPC 2.0: initialize → initialized → tools/list → tools/call. Not a full server,
// just enough surface to exercise the client handshake + a round-trip call.

const encoder = new TextEncoder();
function reply(obj: unknown): void {
  Bun.write(Bun.stdout, encoder.encode(`${JSON.stringify(obj)}\n`));
}

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
            serverInfo: { name: 'mock', version: '0.0.0' }
          }
        });
        break;
      case 'notifications/initialized':
        break; // notification — no response
      case 'tools/list':
        reply({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            tools: [
              {
                name: 'echo',
                description: 'echo back text',
                inputSchema: { type: 'object', properties: { text: { type: 'string' } } }
              },
              {
                name: 'screenshot',
                description: 'return a fake screenshot (text + image content blocks)',
                inputSchema: { type: 'object', properties: {} }
              }
            ]
          }
        });
        break;
      case 'tools/call': {
        const params = msg.params as { name: string; arguments: { text?: string } };
        // A 1x1 transparent PNG, base64 — stands in for a screenshot's image content block.
        const PNG_1X1 =
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
        const content =
          params.name === 'screenshot'
            ? [
                { type: 'text', text: 'here is the screen' },
                { type: 'image', data: PNG_1X1, mimeType: 'image/png' }
              ]
            : [{ type: 'text', text: params.arguments?.text ?? '' }];
        reply({ jsonrpc: '2.0', id: msg.id, result: { content, isError: false } });
        break;
      }
      default:
        reply({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
    }
  }
}
