// Minimal stdio MCP server for testing connectMcpServer. Speaks newline-delimited
// JSON-RPC 2.0: initialize → initialized → tools/list → tools/call. Not a full server,
// just enough surface to exercise the client handshake + a round-trip call.

const encoder = new TextEncoder();
function reply(obj: unknown): void {
  Bun.write(Bun.stdout, encoder.encode(`${JSON.stringify(obj)}\n`));
}

const decoder = new TextDecoder();
let buf = '';
let includeDynamicTool = false;
let appVersion = 1;
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
            capabilities: { tools: { listChanged: true }, resources: { listChanged: true, subscribe: true } },
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
                inputSchema: {
                  type: 'object',
                  properties: { text: { type: 'string' } },
                  required: ['text'],
                  additionalProperties: false
                }
              },
              {
                name: 'screenshot',
                description: 'return a fake screenshot (text + image content blocks)',
                inputSchema: { type: 'object', properties: {} }
              },
              {
                name: 'app',
                description: 'return an MCP App',
                inputSchema: { type: 'object', properties: {}, additionalProperties: false },
                _meta: { ui: { resourceUri: 'ui://mock/app' } }
              },
              ...(includeDynamicTool
                ? [
                    {
                      name: 'dynamic',
                      description: 'added after a list-changed notification',
                      inputSchema: { type: 'object', properties: {} }
                    }
                  ]
                : [])
            ]
          }
        });
        break;
      case 'resources/list':
        reply({
          jsonrpc: '2.0',
          id: msg.id,
          result: { resources: [{ uri: 'ui://mock/app', name: 'Mock App', mimeType: 'text/html;profile=mcp-app' }] }
        });
        break;
      case 'resources/read':
        reply({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            contents: [
              {
                uri: 'ui://mock/app',
                mimeType: 'text/html;profile=mcp-app',
                text: `<main>app-v${appVersion}</main>`,
                _meta: {
                  ui: {
                    csp: { connectDomains: ['https://example.com'] },
                    permissions: { clipboardWrite: false }
                  }
                }
              }
            ]
          }
        });
        break;
      case 'resources/subscribe':
        reply({ jsonrpc: '2.0', id: msg.id, result: {} });
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
            : [{ type: 'text', text: params.arguments?.text ?? (params.name === 'app' ? `app-v${appVersion}` : '') }];
        reply({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content,
            isError: false,
            ...(params.name === 'app' ? { structuredContent: { version: appVersion } } : {})
          }
        });
        if (params.name === 'echo' && params.arguments?.text === 'refresh-tools') {
          includeDynamicTool = true;
          reply({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
        }
        if (params.name === 'echo' && params.arguments?.text === 'refresh-app') {
          appVersion += 1;
          reply({
            jsonrpc: '2.0',
            method: 'notifications/resources/updated',
            params: { uri: 'ui://mock/app' }
          });
        }
        if (params.name === 'echo' && params.arguments?.text === 'crash-after-response') {
          setTimeout(() => process.exit(42), 0);
        }
        break;
      }
      default:
        reply({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
    }
  }
}
