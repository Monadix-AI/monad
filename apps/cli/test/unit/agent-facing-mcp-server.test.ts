import { expect, spyOn, test } from 'bun:test';

import { createAgentFacingMcpHandler } from '../../src/lib/agent-facing-mcp-server.ts';

function ok<T>(data: T) {
  return { data, status: 200 };
}

function err(status: number, error: unknown) {
  return { data: null, error, status };
}

test('agent-facing MCP lists project and direct communication tools', async () => {
  const handler = createAgentFacingMcpHandler({} as never);
  const response = await handler.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list'
  });

  expect(response).toMatchObject({
    jsonrpc: '2.0',
    id: 1,
    result: {
      tools: expect.arrayContaining([
        expect.objectContaining({ name: 'project_post' }),
        expect.objectContaining({ name: 'project_read' }),
        expect.objectContaining({ name: 'project_inbox_check' }),
        expect.objectContaining({ name: 'agent_send' }),
        expect.objectContaining({ name: 'runtime_info' })
      ])
    }
  });
});

test('agent-facing MCP caches mutating tool results by requestId', async () => {
  let calls = 0;
  const client = {
    treaty: {
      v1: {
        internal: {
          'native-agent': {
            project: {
              post: {
                post: async (body: unknown) => {
                  calls++;
                  expect(body).toEqual({ text: 'hello' });
                  return ok({
                    ok: true,
                    message: { id: 'msg_1', projectId: 'prj_1', text: 'hello', createdAt: 'now' }
                  });
                }
              }
            }
          }
        }
      }
    }
  };
  const handler = createAgentFacingMcpHandler(client as never);
  const request = {
    jsonrpc: '2.0' as const,
    id: 2,
    method: 'tools/call',
    params: {
      name: 'project_post',
      arguments: { requestId: 'same-turn', text: 'hello' }
    }
  };

  const first = await handler.handle(request);
  const second = await handler.handle({ ...request, id: 3 });
  if (!first || !('result' in first)) throw new Error('expected first call result');
  if (!second || !('result' in second)) throw new Error('expected second call result');

  expect(calls).toBe(1);
  expect(first.result).toEqual(second.result);
  expect(first.result).toMatchObject({
    content: [{ type: 'text', text: expect.stringContaining('"msg_1"') }],
    isError: false
  });
});

test('agent-facing MCP rejects mutating tools without requestId', async () => {
  let calls = 0;
  const client = {
    treaty: {
      v1: {
        internal: {
          'native-agent': {
            project: {
              post: {
                post: async () => {
                  calls++;
                  return ok({});
                }
              }
            }
          }
        }
      }
    }
  };
  const handler = createAgentFacingMcpHandler(client as never);

  const response = await handler.handle({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'project_post',
      arguments: { text: 'hello' }
    }
  });
  if (!response || !('result' in response)) throw new Error('expected tool error result');

  expect(calls).toBe(0);
  expect(response.result).toEqual({
    content: [{ type: 'text', text: 'project_post requires requestId for idempotency' }],
    isError: true
  });
});

test('agent-facing MCP includes daemon error detail in tool failures', async () => {
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const client = {
      treaty: {
        v1: {
          internal: {
            'native-agent': {
              project: {
                post: {
                  post: async () => err(503, { error: 'daemon unavailable: native-agent route failed' })
                }
              }
            }
          }
        }
      }
    };
    const handler = createAgentFacingMcpHandler(client as never);

    const response = await handler.handle({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'project_post',
        arguments: { requestId: 'detail', text: 'hello' }
      }
    });
    if (!response || !('result' in response)) throw new Error('expected tool error result');

    expect(response.result).toEqual({
      content: [
        { type: 'text', text: 'project_post request failed: 503 daemon unavailable: native-agent route failed' }
      ],
      isError: true
    });
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('"event":"native_agent_mcp_tool_error"'));
  } finally {
    stderr.mockRestore();
  }
});

test('agent-facing MCP includes daemon error code from nested treaty error bodies', async () => {
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const client = {
      treaty: {
        v1: {
          internal: {
            'native-agent': {
              project: {
                post: {
                  post: async () =>
                    err(403, {
                      value: {
                        error: 'attachment path is outside the project working directory: /tmp/proposal.md',
                        code: 'ATTACHMENT_PATH_OUTSIDE_WORKSPACE'
                      }
                    })
                }
              }
            }
          }
        }
      }
    };
    const handler = createAgentFacingMcpHandler(client as never);

    const response = await handler.handle({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'project_post',
        arguments: { requestId: 'nested-detail', text: 'hello' }
      }
    });
    if (!response || !('result' in response)) throw new Error('expected tool error result');

    expect(response.result).toEqual({
      content: [
        {
          type: 'text',
          text: 'project_post request failed: 403 ATTACHMENT_PATH_OUTSIDE_WORKSPACE: attachment path is outside the project working directory: /tmp/proposal.md'
        }
      ],
      isError: true
    });
  } finally {
    stderr.mockRestore();
  }
});
