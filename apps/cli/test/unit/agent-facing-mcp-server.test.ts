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

  if (!response || !('result' in response)) throw new Error('expected tools result');
  const listed = response.result as {
    tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  };
  expect(listed.tools.find((tool) => tool.name === 'session_members')).toEqual({
    name: 'session_members',
    description: 'List current session members and whether Monad can deliver messages to them.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }
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

test('agent-facing MCP reads current session member availability', async () => {
  const previous = Bun.env.MONAD_MESH_SESSION_ID;
  Bun.env.MONAD_MESH_SESSION_ID = 'mesh_current000000';
  try {
    const client = {
      treaty: {
        v1: {
          internal: {
            'native-agent': {
              session: {
                members: {
                  get: async (options: { headers?: Record<string, string> }) => {
                    expect(options).toEqual({ headers: { 'x-monad-mesh-session-id': 'mesh_current000000' } });
                    return ok({
                      members: [
                        { id: 'builder', displayName: 'Builder', status: 'online' },
                        { id: 'reviewer', displayName: 'Reviewer', status: 'offline' }
                      ]
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

    const response = await handler.handle({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'session_members', arguments: {} }
    });

    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                members: [
                  { id: 'builder', displayName: 'Builder', status: 'online' },
                  { id: 'reviewer', displayName: 'Reviewer', status: 'offline' }
                ]
              },
              null,
              2
            )
          }
        ],
        isError: false
      }
    });
  } finally {
    if (previous === undefined) delete Bun.env.MONAD_MESH_SESSION_ID;
    else Bun.env.MONAD_MESH_SESSION_ID = previous;
  }
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
                    message: { id: 'msg_100000000000', projectId: 'prj_100000000000', text: 'hello', createdAt: 'now' }
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
  } finally {
    stderr.mockRestore();
  }
});

test('agent-facing MCP caches failed mutating tool results by requestId', async () => {
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  let calls = 0;
  try {
    const client = {
      treaty: {
        v1: {
          internal: {
            'native-agent': {
              project: {
                post: {
                  post: async () => {
                    calls++;
                    return err(503, { error: 'The operation timed out.' });
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
      id: 7,
      method: 'tools/call',
      params: {
        name: 'project_post',
        arguments: { requestId: 'join-ack-timeout', text: 'joined' }
      }
    };

    const first = await handler.handle(request);
    const retry = await handler.handle({ ...request, id: 8 });
    if (!first || !('result' in first)) throw new Error('expected first tool error result');
    if (!retry || !('result' in retry)) throw new Error('expected retried tool error result');

    expect({ calls, first: first.result, retry: retry.result }).toEqual({
      calls: 1,
      first: {
        content: [{ type: 'text', text: 'project_post request failed: 503 The operation timed out.' }],
        isError: true
      },
      retry: {
        content: [{ type: 'text', text: 'project_post request failed: 503 The operation timed out.' }],
        isError: true
      }
    });
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
