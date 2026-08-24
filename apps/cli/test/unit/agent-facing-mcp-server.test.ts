import { expect, spyOn, test } from 'bun:test';

import { createAgentFacingMcpHandler } from '../../src/lib/agent-facing-mcp-server.ts';

const MAX_JSON_RPC_LINE_BYTES = 48 * 1024;

type McpHandler = ReturnType<typeof createAgentFacingMcpHandler>;

type ProjectReadChunk = {
  encoding: 'json-utf8-chunks';
  snapshotId: string;
  chunk: string;
  offsetBytes: number;
  returnedBytes: number;
  totalBytes: number;
  sha256: string;
  complete: boolean;
  nextCursor?: string;
};

function ok<T>(data: T) {
  return { data, status: 200 };
}

function err(status: number, error: unknown) {
  return { data: null, error, status };
}

function projectReadChunk(response: Awaited<ReturnType<McpHandler['handle']>>): ProjectReadChunk {
  if (!response || !('result' in response)) throw new Error('expected tool result');
  if (!response.result || typeof response.result !== 'object' || Array.isArray(response.result)) {
    throw new Error('expected object tool result');
  }
  const result = response.result as Record<string, unknown>;
  expect(result.isError).toBe(false);
  const content = result.content;
  if (!Array.isArray(content) || content.length !== 1) throw new Error('expected one content item');
  const item = content[0];
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('expected text content');
  const text = (item as Record<string, unknown>).text;
  if (typeof text !== 'string') throw new Error('expected text payload');
  return JSON.parse(text) as ProjectReadChunk;
}

async function collectProjectRead(
  handler: McpHandler,
  initialArguments: Record<string, unknown> = {}
): Promise<{ chunks: ProjectReadChunk[]; responses: unknown[] }> {
  const chunks: ProjectReadChunk[] = [];
  const responses: unknown[] = [];
  let cursor: string | undefined;
  do {
    const response = await handler.handle({
      jsonrpc: '2.0',
      id: `read-${chunks.length}`,
      method: 'tools/call',
      params: { name: 'project_read', arguments: cursor ? { cursor } : initialArguments }
    });
    responses.push(response);
    expect(new TextEncoder().encode(`${JSON.stringify(response)}\n`).byteLength).toBeLessThanOrEqual(
      MAX_JSON_RPC_LINE_BYTES
    );
    const chunk = projectReadChunk(response);
    chunks.push(chunk);
    cursor = chunk.nextCursor;
  } while (cursor);
  return { chunks, responses };
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
  expect(listed.tools.find((tool) => tool.name === 'project_post')?.inputSchema).toEqual({
    type: 'object',
    properties: {
      requestId: {
        type: 'string',
        description: 'Stable idempotency key for this intended side effect. Reuse it when retrying the same action.'
      },
      deliveryMode: { type: 'string', enum: ['queue', 'steer'], default: 'queue' },
      text: { type: 'string' },
      replyToMessageId: { type: 'string' },
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
    required: ['requestId'],
    additionalProperties: false
  });
  expect(listed.tools.find((tool) => tool.name === 'project_read')?.inputSchema).toEqual({
    type: 'object',
    properties: {
      messageId: { type: 'string' },
      before: { type: 'string' },
      after: { type: 'string' },
      around: { type: 'string' },
      limit: { type: 'number' },
      cursor: { type: 'string' }
    },
    required: [],
    additionalProperties: false
  });
  const agentSendInputSchema = listed.tools.find((tool) => tool.name === 'agent_send')?.inputSchema as
    | { properties?: Record<string, unknown> }
    | undefined;
  expect(agentSendInputSchema?.properties?.deliveryMode).toEqual({
    type: 'string',
    enum: ['queue', 'steer'],
    default: 'queue'
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
                  get: async (options: { headers?: Record<string, string>; fetch?: RequestInit }) => {
                    expect(options).toEqual({
                      headers: { 'x-monad-mesh-session-id': 'mesh_current000000' },
                      fetch: { signal: expect.any(AbortSignal) }
                    });
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

test('agent-facing MCP forwards explicit project reply ids and caches mutating results by requestId', async () => {
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
                  expect(body).toEqual({
                    requestId: 'same-turn',
                    deliveryMode: 'queue',
                    text: 'hello',
                    replyToMessageId: 'msg_PARENT000000'
                  });
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
      arguments: { requestId: 'same-turn', text: 'hello', replyToMessageId: 'msg_PARENT000000' }
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

test('agent-facing MCP forwards one multi-question project ask card atomically', async () => {
  const bodies: unknown[] = [];
  const client = {
    treaty: {
      v1: {
        internal: {
          'native-agent': {
            project: {
              ask: {
                post: async (body: unknown) => {
                  bodies.push(body);
                  return ok({
                    ok: true,
                    requestId: 'ask-card',
                    status: 'answered',
                    answer: '{"scope":"all","targets":["Codex","Claude"]}',
                    answers: { scope: 'all', targets: ['Codex', 'Claude'] }
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

  await handler.handle({
    jsonrpc: '2.0',
    id: 31,
    method: 'tools/call',
    params: {
      name: 'project_ask',
      arguments: {
        requestId: 'ask-card',
        blocking: true,
        questions: [
          { id: 'scope', question: 'Scope?', options: ['all'], mode: 'single', allowOther: true },
          {
            id: 'targets',
            question: 'Targets?',
            options: ['Codex', 'Claude'],
            mode: 'multiple',
            allowOther: false
          }
        ]
      }
    }
  });

  expect(bodies).toEqual([
    {
      requestId: 'ask-card',
      blocking: true,
      questions: [
        { id: 'scope', question: 'Scope?', options: ['all'], mode: 'single', allowOther: true },
        {
          id: 'targets',
          question: 'Targets?',
          options: ['Codex', 'Claude'],
          mode: 'multiple',
          allowOther: false
        }
      ]
    }
  ]);
});

test('agent-facing MCP forwards an exact project message read id', async () => {
  const client = {
    treaty: {
      v1: {
        internal: {
          'native-agent': {
            project: {
              read: {
                post: async (body: unknown) => {
                  expect(body).toEqual({ messageId: 'msg_TARGET000000' });
                  return ok({ messages: [{ id: 'msg_TARGET000000', text: 'target' }] });
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
    params: { name: 'project_read', arguments: { messageId: 'msg_TARGET000000' } }
  });

  expect(response).toEqual({
    jsonrpc: '2.0',
    id: 4,
    result: {
      content: [
        { type: 'text', text: JSON.stringify({ messages: [{ id: 'msg_TARGET000000', text: 'target' }] }, null, 2) }
      ],
      isError: false
    }
  });
});

test('agent-facing MCP continues an oversized multi-message project read from one immutable snapshot', async () => {
  let calls = 0;
  const data = {
    messages: Array.from({ length: 5 }, (_, index) => ({
      id: `msg_${index}`,
      text: `${index}:${'project transcript line\n'.repeat(1_100)}`
    }))
  };
  const client = {
    treaty: {
      v1: {
        internal: {
          'native-agent': {
            project: {
              read: {
                post: async () => {
                  calls++;
                  return ok(data);
                }
              }
            }
          }
        }
      }
    }
  };
  const handler = createAgentFacingMcpHandler(client as never);

  const { chunks } = await collectProjectRead(handler, { limit: 100 });
  const expected = JSON.stringify(data, null, 2);
  const digest = new Bun.CryptoHasher('sha256').update(expected).digest('hex');

  expect(chunks.length).toBeGreaterThan(1);
  const snapshotId = chunks[0]?.snapshotId;
  if (!snapshotId) throw new Error('expected snapshot id');
  expect(chunks.map((chunk) => chunk.snapshotId)).toEqual(chunks.map(() => snapshotId));
  expect(chunks.map((chunk) => chunk.offsetBytes)).toEqual(
    chunks.map((_, index) => chunks.slice(0, index).reduce((total, chunk) => total + chunk.returnedBytes, 0))
  );
  expect(chunks.map((chunk) => chunk.encoding)).toEqual(chunks.map(() => 'json-utf8-chunks'));
  expect(chunks.map((chunk) => chunk.sha256)).toEqual(chunks.map(() => digest));
  expect(chunks.map((chunk) => chunk.totalBytes)).toEqual(
    chunks.map(() => new TextEncoder().encode(expected).byteLength)
  );
  expect(chunks.at(-1)?.complete).toBe(true);
  expect(chunks.slice(0, -1).every((chunk) => chunk.complete === false && typeof chunk.nextCursor === 'string')).toBe(
    true
  );
  expect(chunks.map((chunk) => chunk.chunk).join('')).toBe(expected);
  expect(calls).toBe(1);
});

test('agent-facing MCP continues an oversized single project message', async () => {
  let calls = 0;
  const data = { messages: [{ id: 'msg_SINGLE000000', text: 'single-message-body/'.repeat(8_000) }] };
  const client = {
    treaty: {
      v1: {
        internal: {
          'native-agent': {
            project: {
              read: {
                post: async () => {
                  calls++;
                  return ok(data);
                }
              }
            }
          }
        }
      }
    }
  };

  const { chunks } = await collectProjectRead(createAgentFacingMcpHandler(client as never), {
    messageId: 'msg_SINGLE000000'
  });

  expect(chunks.length).toBeGreaterThan(1);
  expect({
    calls,
    reconstructed: chunks.map((chunk) => chunk.chunk).join('')
  }).toEqual({
    calls: 1,
    reconstructed: JSON.stringify(data, null, 2)
  });
});

test('agent-facing MCP splits Unicode project reads only at UTF-8 boundaries', async () => {
  const data = {
    messages: [{ id: 'msg_UNICODE00000', text: '🙂汉字e\u0301🚀'.repeat(18_000) }]
  };
  const client = {
    treaty: {
      v1: {
        internal: {
          'native-agent': {
            project: { read: { post: async () => ok(data) } }
          }
        }
      }
    }
  };

  const { chunks } = await collectProjectRead(createAgentFacingMcpHandler(client as never));
  const expected = JSON.stringify(data, null, 2);

  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.every((chunk) => !chunk.chunk.includes('\uFFFD'))).toBe(true);
  expect(chunks.map((chunk) => new TextEncoder().encode(chunk.chunk).byteLength)).toEqual(
    chunks.map((chunk) => chunk.returnedBytes)
  );
  expect(chunks.map((chunk) => chunk.chunk).join('')).toBe(expected);
  expect(chunks.at(-1)?.sha256).toBe(new Bun.CryptoHasher('sha256').update(expected).digest('hex'));
});

test('agent-facing MCP evicts large-read snapshots oldest-first at the entry limit', async () => {
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  let calls = 0;
  const client = {
    treaty: {
      v1: {
        internal: {
          'native-agent': {
            project: {
              read: {
                post: async () => ok({ messages: [{ id: `msg_${calls}`, text: `${calls++}:${'x'.repeat(55_000)}` }] })
              }
            }
          }
        }
      }
    }
  };
  try {
    const handler = createAgentFacingMcpHandler(client as never);
    const cursors: string[] = [];
    for (let index = 0; index < 17; index++) {
      const response = await handler.handle({
        jsonrpc: '2.0',
        id: index,
        method: 'tools/call',
        params: { name: 'project_read', arguments: {} }
      });
      const cursor = projectReadChunk(response).nextCursor;
      if (!cursor) throw new Error('expected continuation cursor');
      cursors.push(cursor);
    }

    const evicted = await handler.handle({
      jsonrpc: '2.0',
      id: 100,
      method: 'tools/call',
      params: { name: 'project_read', arguments: { cursor: cursors[0] } }
    });
    const retained = await handler.handle({
      jsonrpc: '2.0',
      id: 101,
      method: 'tools/call',
      params: { name: 'project_read', arguments: { cursor: cursors[1] } }
    });

    expect(evicted).toMatchObject({
      result: {
        content: [{ type: 'text', text: expect.stringContaining('call project_read again without cursor') }],
        isError: true
      }
    });
    expect(projectReadChunk(retained).offsetBytes).toBeGreaterThan(0);
    expect(calls).toBe(17);
  } finally {
    stderr.mockRestore();
  }
});

test('agent-facing MCP bounds large-read snapshots to eight MiB total', async () => {
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  let calls = 0;
  const client = {
    treaty: {
      v1: {
        internal: {
          'native-agent': {
            project: {
              read: {
                post: async () =>
                  ok({ messages: [{ id: `msg_${calls}`, text: `${calls++}:${'x'.repeat(1_100_000)}` }] })
              }
            }
          }
        }
      }
    }
  };
  try {
    const handler = createAgentFacingMcpHandler(client as never);
    const cursors: string[] = [];
    for (let index = 0; index < 8; index++) {
      const response = await handler.handle({
        jsonrpc: '2.0',
        id: index,
        method: 'tools/call',
        params: { name: 'project_read', arguments: {} }
      });
      const cursor = projectReadChunk(response).nextCursor;
      if (!cursor) throw new Error('expected continuation cursor');
      cursors.push(cursor);
    }

    const evicted = await handler.handle({
      jsonrpc: '2.0',
      id: 200,
      method: 'tools/call',
      params: { name: 'project_read', arguments: { cursor: cursors[0] } }
    });
    const retained = await handler.handle({
      jsonrpc: '2.0',
      id: 201,
      method: 'tools/call',
      params: { name: 'project_read', arguments: { cursor: cursors.at(-1) } }
    });

    expect(evicted).toMatchObject({ result: { isError: true } });
    expect(projectReadChunk(retained).complete).toBe(false);
    expect(calls).toBe(8);
  } finally {
    stderr.mockRestore();
  }
});

test(
  'agent-facing MCP retains one snapshot larger than the eight MiB cache target through completion',
  async () => {
    let calls = 0;
    const data = { messages: [{ id: 'msg_OVERSIZED000', text: 'x'.repeat(8 * 1024 * 1024) }] };
    const client = {
      treaty: {
        v1: {
          internal: {
            'native-agent': {
              project: {
                read: {
                  post: async () => {
                    calls++;
                    return ok(data);
                  }
                }
              }
            }
          }
        }
      }
    };

    const { chunks } = await collectProjectRead(createAgentFacingMcpHandler(client as never));
    const expected = JSON.stringify(data, null, 2);

    expect(chunks.at(-1)?.complete).toBe(true);
    expect(chunks.map((chunk) => chunk.chunk).join('')).toBe(expected);
    expect(chunks.at(-1)?.sha256).toBe(new Bun.CryptoHasher('sha256').update(expected).digest('hex'));
    expect(calls).toBe(1);
  },
  process.platform === 'win32' ? 30_000 : 15_000
);

test('agent-facing MCP expires large-read snapshots after five minutes', async () => {
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  const now = spyOn(Date, 'now');
  let currentTime = 1_000_000;
  now.mockImplementation(() => currentTime);
  const client = {
    treaty: {
      v1: {
        internal: {
          'native-agent': {
            project: { read: { post: async () => ok({ messages: [{ text: 'x'.repeat(60_000) }] }) } }
          }
        }
      }
    }
  };
  try {
    const handler = createAgentFacingMcpHandler(client as never);
    const initial = await handler.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'project_read', arguments: {} }
    });
    const cursor = projectReadChunk(initial).nextCursor;
    if (!cursor) throw new Error('expected continuation cursor');
    currentTime += 5 * 60 * 1_000 + 1;

    const expired = await handler.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'project_read', arguments: { cursor } }
    });

    expect(expired).toMatchObject({
      result: {
        content: [{ type: 'text', text: expect.stringContaining('call project_read again without cursor') }],
        isError: true
      }
    });
  } finally {
    now.mockRestore();
    stderr.mockRestore();
  }
});

test('agent-facing MCP rejects an invalid project message id before calling the daemon', async () => {
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  let calls = 0;
  const client = {
    treaty: {
      v1: {
        internal: {
          'native-agent': {
            project: {
              read: {
                post: async () => {
                  calls++;
                  return ok({ messages: [] });
                }
              }
            }
          }
        }
      }
    }
  };
  const handler = createAgentFacingMcpHandler(client as never);

  try {
    const response = await handler.handle({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'project_read', arguments: { messageId: 'not-a-message-id' } }
    });
    if (!response || !('result' in response)) throw new Error('expected tool error result');

    expect(calls).toBe(0);
    expect(response.result).toEqual({
      content: [{ type: 'text', text: expect.stringContaining('Invalid string') }],
      isError: true
    });
  } finally {
    stderr.mockRestore();
  }
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

test('agent-facing MCP aborts a cancelled read-only call without reconciling a project ask', async () => {
  let readStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    readStarted = resolve;
  });
  let aborted = false;
  const client = {
    treaty: {
      v1: {
        internal: {
          'native-agent': {
            project: {
              read: {
                post: async (_body: unknown, options: { fetch?: RequestInit }) => {
                  readStarted();
                  return new Promise((resolve) => {
                    options.fetch?.signal?.addEventListener('abort', () => {
                      aborted = true;
                      resolve(err(499, 'read cancelled'));
                    });
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
  const pending = handler.handle({
    jsonrpc: '2.0',
    id: 'read-cancel',
    method: 'tools/call',
    params: { name: 'project_read', arguments: {} }
  });
  await started;

  const cancelled = await handler.handle({
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: 'read-cancel' }
  });
  await pending;

  expect({ cancelled, aborted }).toEqual({ cancelled: null, aborted: true });
});

test('agent-facing MCP aborts a cancelled mutating call without project ask reconciliation', async () => {
  let sendStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    sendStarted = resolve;
  });
  let aborted = false;
  let sentBody: unknown;
  const client = {
    treaty: {
      v1: {
        internal: {
          'native-agent': {
            agent: {
              send: {
                post: async (body: unknown, options: { fetch?: RequestInit }) => {
                  sentBody = body;
                  sendStarted();
                  return new Promise((resolve) => {
                    options.fetch?.signal?.addEventListener('abort', () => {
                      aborted = true;
                      resolve(err(499, 'send cancelled'));
                    });
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
  const pending = handler.handle({
    jsonrpc: '2.0',
    id: 'send-cancel',
    method: 'tools/call',
    params: { name: 'agent_send', arguments: { requestId: 'send-cancel', to: 'reviewer', text: 'Stop' } }
  });
  await started;

  const cancelled = await handler.handle({
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: 'send-cancel' }
  });
  await pending;

  expect({ cancelled, aborted, sentBody }).toEqual({
    cancelled: null,
    aborted: true,
    sentBody: { requestId: 'send-cancel', to: 'reviewer', deliveryMode: 'queue', text: 'Stop' }
  });
});

test('agent-facing MCP uses exact normal and non-blocking ask deadline budgets', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers: Array<{ delay: number; callback: () => void }> = [];
  globalThis.setTimeout = ((callback: TimerHandler, delay?: number) => {
    timers.push({ delay: Number(delay), callback: callback as () => void });
    return timers.length as never;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
  try {
    let readStarted!: () => void;
    const readStartedPromise = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    let askStarted!: () => void;
    const askStartedPromise = new Promise<void>((resolve) => {
      askStarted = resolve;
    });
    const client = {
      treaty: {
        v1: {
          internal: {
            'native-agent': {
              project: {
                read: {
                  post: async (_body: unknown, options: { fetch?: RequestInit }) => {
                    readStarted();
                    return new Promise((resolve) => {
                      options.fetch?.signal?.addEventListener('abort', () => resolve(err(499, 'read deadline')));
                    });
                  }
                },
                ask: {
                  post: async (_body: unknown, options: { fetch?: RequestInit }) => {
                    askStarted();
                    return new Promise((resolve) => {
                      options.fetch?.signal?.addEventListener('abort', () => resolve(err(499, 'ask deadline')));
                    });
                  },
                  cancel: { post: async () => ok({ ok: true }) }
                }
              }
            }
          }
        }
      }
    };
    const handler = createAgentFacingMcpHandler(client as never);

    const read = handler.handle({
      jsonrpc: '2.0',
      id: 'read-deadline',
      method: 'tools/call',
      params: { name: 'project_read', arguments: {} }
    });
    await readStartedPromise;
    const normalTimer = timers.shift();
    normalTimer?.callback();
    await read;

    const ask = handler.handle({
      jsonrpc: '2.0',
      id: 'ask-deadline',
      method: 'tools/call',
      params: {
        name: 'project_ask',
        arguments: { requestId: 'ask-deadline', question: 'Continue?', blocking: false, autoResolutionMs: 60000 }
      }
    });
    await askStartedPromise;
    const askTimer = timers.shift();
    askTimer?.callback();
    await ask;

    expect({ normalDelay: normalTimer?.delay, askDelay: askTimer?.delay }).toEqual({
      normalDelay: 30_000,
      askDelay: 65_000
    });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('agent-facing MCP clears normal and ask deadlines on shutdown', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers: Array<{ id: number; delay: number }> = [];
  const cleared: number[] = [];
  globalThis.setTimeout = ((_: TimerHandler, delay?: number) => {
    const id = timers.length + 1;
    timers.push({ id, delay: Number(delay) });
    return id as never;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => {
    cleared.push(id);
  }) as unknown as typeof clearTimeout;
  try {
    let readStarted!: () => void;
    const readStartedPromise = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    let askStarted!: () => void;
    const askStartedPromise = new Promise<void>((resolve) => {
      askStarted = resolve;
    });
    const client = {
      treaty: {
        v1: {
          internal: {
            'native-agent': {
              project: {
                read: {
                  post: async () => {
                    readStarted();
                    return new Promise(() => {});
                  }
                },
                ask: {
                  post: async () => {
                    askStarted();
                    return new Promise(() => {});
                  },
                  cancel: { post: async () => ok({ ok: true }) }
                }
              }
            }
          }
        }
      }
    };
    const handler = createAgentFacingMcpHandler(client as never);
    void handler.handle({
      jsonrpc: '2.0',
      id: 'read-shutdown',
      method: 'tools/call',
      params: { name: 'project_read', arguments: {} }
    });
    void handler.handle({
      jsonrpc: '2.0',
      id: 'ask-shutdown',
      method: 'tools/call',
      params: { name: 'project_ask', arguments: { requestId: 'ask-shutdown', question: 'Wait?' } }
    });
    await Promise.all([readStartedPromise, askStartedPromise]);

    await handler.close();

    const normalDeadline = timers.find((timer) => timer.delay === 30_000);
    const askDeadline = timers.find((timer) => timer.delay === 245_000);
    expect(cleared).toEqual(expect.arrayContaining([normalDeadline?.id, askDeadline?.id]));
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('agent-facing MCP cancels a live project ask by exact tool request id without blocking other calls', async () => {
  let askStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    askStarted = resolve;
  });
  let aborted = false;
  const cancellations: unknown[] = [];
  const client = {
    treaty: {
      v1: {
        internal: {
          'native-agent': {
            project: {
              ask: {
                post: async (_body: unknown, options: { fetch?: RequestInit }) => {
                  askStarted();
                  return new Promise((resolve) => {
                    options.fetch?.signal?.addEventListener('abort', () => {
                      aborted = true;
                      resolve(ok({ ok: true, requestId: 'ask-live', status: 'timed_out' }));
                    });
                  });
                },
                cancel: {
                  post: async (body: unknown) => {
                    cancellations.push(body);
                    return ok({ ok: true, requestId: 'ask-live', status: 'timed_out' });
                  }
                }
              }
            }
          }
        }
      }
    }
  };
  const handler = createAgentFacingMcpHandler(client as never);
  const pending = handler.handle({
    jsonrpc: '2.0',
    id: 41,
    method: 'tools/call',
    params: {
      name: 'project_ask',
      arguments: { requestId: 'ask-live', question: 'Continue?' }
    }
  });
  await started;

  const list = await handler.handle({ jsonrpc: '2.0', id: 42, method: 'tools/list' });
  const cancelled = await handler.handle({
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: 41, reason: 'tool timeout' }
  });
  await pending;

  expect({ listId: list?.id, cancelled, aborted, cancellations }).toEqual({
    listId: 42,
    cancelled: null,
    aborted: true,
    cancellations: [{ requestId: 'ask-live', cause: 'timeout' }]
  });
});

test('agent-facing MCP aborts asks immediately while bounding cancellation reconciliation', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers: Array<{ delay: number; callback: () => void }> = [];
  globalThis.setTimeout = ((callback: TimerHandler, delay?: number) => {
    timers.push({ delay: Number(delay), callback: callback as () => void });
    return timers.length as never;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
  try {
    let askStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      askStarted = resolve;
    });
    let originalAskSignal: AbortSignal | undefined;
    let reconciliationSignal: AbortSignal | undefined;
    let reconciliationAborted = false;
    const client = {
      treaty: {
        v1: {
          internal: {
            'native-agent': {
              project: {
                ask: {
                  post: async (_body: unknown, options: { fetch?: RequestInit }) => {
                    originalAskSignal = options.fetch?.signal ?? undefined;
                    askStarted();
                    return new Promise((resolve) => {
                      options.fetch?.signal?.addEventListener('abort', () =>
                        resolve(err(499, 'ask cancelled immediately'))
                      );
                    });
                  },
                  cancel: {
                    post: async (_body: unknown, options: { fetch?: RequestInit }) => {
                      reconciliationSignal = options.fetch?.signal ?? undefined;
                      return new Promise((resolve) => {
                        options.fetch?.signal?.addEventListener('abort', () => {
                          reconciliationAborted = true;
                          resolve(ok({ ok: true, requestId: 'ask-stuck', status: 'timed_out' }));
                        });
                      });
                    }
                  }
                }
              }
            }
          }
        }
      }
    };
    const handler = createAgentFacingMcpHandler(client as never);
    const pending = handler.handle({
      jsonrpc: '2.0',
      id: 'ask-stuck-call',
      method: 'tools/call',
      params: { name: 'project_ask', arguments: { requestId: 'ask-stuck', question: 'Continue?' } }
    });
    await started;

    const notification = handler.handle({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 'ask-stuck-call' }
    });
    let notificationSettled = false;
    void notification.then(() => {
      notificationSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect({
      originalAskAborted: originalAskSignal?.aborted,
      notificationSettled,
      reconciliationUsesSeparateSignal: reconciliationSignal !== originalAskSignal
    }).toEqual({
      originalAskAborted: true,
      notificationSettled: true,
      reconciliationUsesSeparateSignal: true
    });

    const closing = handler.close();
    const reconciliationTimer = timers.find((timer) => timer.delay === 5_000);
    reconciliationTimer?.callback();
    await Promise.all([pending, notification, closing]);

    expect(reconciliationAborted).toBe(true);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('agent-facing MCP detaches live bounded asks on transport EOF', async () => {
  let askStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    askStarted = resolve;
  });
  const cancellations: unknown[] = [];
  const client = {
    treaty: {
      v1: {
        internal: {
          'native-agent': {
            project: {
              ask: {
                post: async (_body: unknown, options: { fetch?: RequestInit }) => {
                  askStarted();
                  return new Promise((resolve) => {
                    options.fetch?.signal?.addEventListener('abort', () =>
                      resolve(ok({ ok: true, requestId: 'ask-eof', status: 'detached_sync' }))
                    );
                  });
                },
                cancel: {
                  post: async (body: unknown) => {
                    cancellations.push(body);
                    return ok({ ok: true, requestId: 'ask-eof', status: 'detached_sync' });
                  }
                }
              }
            }
          }
        }
      }
    }
  };
  const handler = createAgentFacingMcpHandler(client as never);
  const pending = handler.handle({
    jsonrpc: '2.0',
    id: 'call-eof',
    method: 'tools/call',
    params: { name: 'project_ask', arguments: { requestId: 'ask-eof', question: 'Wait?' } }
  });
  await started;

  await handler.close();
  await pending;

  expect(cancellations).toEqual([{ requestId: 'ask-eof', cause: 'transport_eof' }]);
});

function planClient(routes: {
  get?: (options: { headers?: Record<string, string>; fetch?: RequestInit }) => Promise<unknown>;
  add?: (body: unknown, options: { headers?: Record<string, string>; fetch?: RequestInit }) => Promise<unknown>;
  update?: (body: unknown, options: { headers?: Record<string, string>; fetch?: RequestInit }) => Promise<unknown>;
  del?: (body: unknown, options: { headers?: Record<string, string>; fetch?: RequestInit }) => Promise<unknown>;
}) {
  return {
    treaty: {
      v1: {
        internal: {
          'native-agent': {
            project: {
              plan: {
                get: routes.get ?? (async () => ok({ plan: { sessionId: 'ses_planzzz00001', todos: [] } })),
                todos: {
                  post: routes.add ?? (async () => ok({ todo: {} })),
                  update: { post: routes.update ?? (async () => ok({ todo: {} })) },
                  delete: { post: routes.del ?? (async () => ok({ todo: {} })) }
                }
              }
            }
          }
        }
      }
    }
  };
}

async function callPlanTool(client: unknown, name: string, args: Record<string, unknown>, id: number | string = 1) {
  const handler = createAgentFacingMcpHandler(client as never);
  const response = await handler.handle({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args }
  });
  if (!response || !('result' in response)) throw new Error('expected tool result');
  return response.result as { content: Array<{ type: 'text'; text: string }>; isError: boolean };
}

test('agent-facing MCP lists the four session-plan tools with parse-ready schemas', async () => {
  const handler = createAgentFacingMcpHandler({} as never);
  const response = await handler.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  if (!response || !('result' in response)) throw new Error('expected tools result');
  const listed = response.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> };

  expect(listed.tools.map((tool) => tool.name).filter((name) => name.startsWith('project_plan_'))).toEqual([
    'project_plan_list',
    'project_plan_add',
    'project_plan_update',
    'project_plan_delete'
  ]);
  // The published contract is derived from the protocol request schema (idempotencyKeySchema pattern,
  // todo/version bounds, enum, strict object) — not a hand-written duplicate that can drift from the wire.
  const REQUEST_ID_DESCRIPTION =
    'Stable idempotency key for this intended side effect. Reuse it when retrying the same action.';
  const idempotencyKey = { type: 'string', pattern: '^idem_[0-9a-zA-Z]{12}$', description: REQUEST_ID_DESCRIPTION };
  const todoId = { type: 'string', pattern: '^todo_[0-9a-zA-Z]{12}$' };
  const version = { type: 'integer', minimum: 0, maximum: 9007199254740991 };
  const status = { type: 'string', enum: ['pending', 'in_progress', 'completed'] };
  const text = { type: 'string', minLength: 1, maxLength: 4096 };

  expect(listed.tools.find((tool) => tool.name === 'project_plan_add')?.inputSchema).toEqual({
    type: 'object',
    properties: {
      requestId: idempotencyKey,
      text,
      status,
      assigneeProjectMemberId: {
        type: 'string',
        minLength: 1,
        maxLength: 512,
        description: 'Assign this to-do to a project member by their canonical projectMemberId.'
      }
    },
    required: ['requestId', 'text'],
    additionalProperties: false
  });
  expect(listed.tools.find((tool) => tool.name === 'project_plan_update')?.inputSchema).toEqual({
    type: 'object',
    properties: {
      todoId,
      requestId: idempotencyKey,
      expectedVersion: version,
      patch: {
        type: 'object',
        properties: {
          text,
          status,
          assigneeProjectMemberId: {
            anyOf: [{ type: 'string', minLength: 1, maxLength: 512 }, { type: 'null' }],
            description: 'Set the assignee by projectMemberId, or null to clear it.'
          }
        },
        additionalProperties: false,
        minProperties: 1
      }
    },
    required: ['todoId', 'requestId', 'expectedVersion', 'patch'],
    additionalProperties: false
  });
  expect(listed.tools.find((tool) => tool.name === 'project_plan_delete')?.inputSchema).toEqual({
    type: 'object',
    properties: { todoId, requestId: idempotencyKey, expectedVersion: version },
    required: ['todoId', 'requestId', 'expectedVersion'],
    additionalProperties: false
  });
  // project_plan_list takes no arguments — a strict empty object.
  expect(listed.tools.find((tool) => tool.name === 'project_plan_list')?.inputSchema).toEqual({
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false
  });
});

test('plan tool contracts reject malformed input at execution parse, matching the published schema constraints', async () => {
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  let calls = 0;
  try {
    const client = planClient({
      add: async () => {
        calls++;
        return ok({ todo: {} });
      },
      update: async () => {
        calls++;
        return ok({ todo: { id: 'todo_ok0000000001', version: 1 } });
      }
    });
    // Each malformed input violates a constraint the published JSON Schema encodes (minimum 0, integer,
    // minProperties 1, maxLength 4096, minLength 1); the daemon-parse layer rejects the very same inputs, so
    // the route is never reached.
    const malformed = await Promise.all([
      callPlanTool(client, 'project_plan_update', {
        requestId: 'idem_planbad00001',
        todoId: 'todo_bad000000001',
        expectedVersion: -1,
        patch: { status: 'completed' }
      }),
      callPlanTool(client, 'project_plan_update', {
        requestId: 'idem_planbad00002',
        todoId: 'todo_bad000000001',
        expectedVersion: 1.5,
        patch: { status: 'completed' }
      }),
      callPlanTool(client, 'project_plan_update', {
        requestId: 'idem_planbad00003',
        todoId: 'todo_bad000000001',
        expectedVersion: 0,
        patch: {}
      }),
      callPlanTool(client, 'project_plan_add', { requestId: 'idem_planbad00004', text: 'x'.repeat(4097) }),
      callPlanTool(client, 'project_plan_add', {
        requestId: 'idem_planbad00005',
        text: 'ok',
        assigneeProjectMemberId: ''
      })
    ]);
    expect(calls).toBe(0);
    expect(malformed.map((result) => result.isError)).toEqual([true, true, true, true, true]);

    // The integer lower bound is inclusive: expectedVersion 0 (a freshly-added todo) is valid and reaches
    // the daemon — proving the constraint is exactly integer >= 0, not > 0.
    const boundary = await callPlanTool(client, 'project_plan_update', {
      requestId: 'idem_planok000001',
      todoId: 'todo_ok0000000001',
      expectedVersion: 0,
      patch: { status: 'in_progress' }
    });
    expect(boundary.isError).toBe(false);
    expect(calls).toBe(1);
  } finally {
    stderr.mockRestore();
  }
});

test('project_plan_list reads the plan through the internal route with only the mesh-session header', async () => {
  const previous = Bun.env.MONAD_MESH_SESSION_ID;
  Bun.env.MONAD_MESH_SESSION_ID = 'mesh_planlist0001';
  try {
    const client = planClient({
      get: async (options) => {
        expect(options).toEqual({
          headers: { 'x-monad-mesh-session-id': 'mesh_planlist0001' },
          fetch: { signal: expect.any(AbortSignal) }
        });
        return ok({ plan: { sessionId: 'ses_planlist0001', todos: [] } });
      }
    });
    const result = await callPlanTool(client, 'project_plan_list', {});
    expect(result).toEqual({
      content: [
        { type: 'text', text: JSON.stringify({ plan: { sessionId: 'ses_planlist0001', todos: [] } }, null, 2) }
      ],
      isError: false
    });
  } finally {
    if (previous === undefined) delete Bun.env.MONAD_MESH_SESSION_ID;
    else Bun.env.MONAD_MESH_SESSION_ID = previous;
  }
});

test('project_plan_add forwards the parsed todo body to the internal plan route', async () => {
  const bodies: unknown[] = [];
  const todo = {
    id: 'todo_addaddadd001',
    sessionId: 'ses_planadd00001',
    text: 'ship it',
    status: 'in_progress',
    assigneeProjectMemberId: 'pmem_reviewer0001',
    version: 0,
    createdBy: { source: {} },
    updatedBy: { source: {} },
    createdAt: 'now',
    updatedAt: 'now'
  };
  const client = planClient({
    add: async (body) => {
      bodies.push(body);
      return ok({ todo });
    }
  });
  const result = await callPlanTool(client, 'project_plan_add', {
    requestId: 'idem_planadd00001',
    text: 'ship it',
    status: 'in_progress',
    assigneeProjectMemberId: 'pmem_reviewer0001'
  });

  expect(bodies).toEqual([
    {
      requestId: 'idem_planadd00001',
      text: 'ship it',
      status: 'in_progress',
      assigneeProjectMemberId: 'pmem_reviewer0001'
    }
  ]);
  expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify({ todo }, null, 2) }], isError: false });
});

test('project_plan_update forwards the todo id, expected version, and patch (including a null assignee clear)', async () => {
  const bodies: unknown[] = [];
  const client = planClient({
    update: async (body) => {
      bodies.push(body);
      return ok({ todo: { id: 'todo_upd000000001', version: 3 } });
    }
  });
  const result = await callPlanTool(client, 'project_plan_update', {
    requestId: 'idem_planupd00001',
    todoId: 'todo_upd000000001',
    expectedVersion: 2,
    patch: { status: 'completed', assigneeProjectMemberId: null }
  });

  expect(bodies).toEqual([
    {
      requestId: 'idem_planupd00001',
      todoId: 'todo_upd000000001',
      expectedVersion: 2,
      patch: { status: 'completed', assigneeProjectMemberId: null }
    }
  ]);
  expect(result.isError).toBe(false);
});

test('project_plan_delete forwards the todo id and expected version and returns the deletion receipt', async () => {
  const bodies: unknown[] = [];
  const client = planClient({
    del: async (body) => {
      bodies.push(body);
      return ok({ deleted: true, todoId: 'todo_del000000001' });
    }
  });
  const result = await callPlanTool(client, 'project_plan_delete', {
    requestId: 'idem_plandel00001',
    todoId: 'todo_del000000001',
    expectedVersion: 5
  });

  expect(bodies).toEqual([{ requestId: 'idem_plandel00001', todoId: 'todo_del000000001', expectedVersion: 5 }]);
  expect(result).toEqual({
    content: [{ type: 'text', text: JSON.stringify({ deleted: true, todoId: 'todo_del000000001' }, null, 2) }],
    isError: false
  });
});

test('project_plan_update surfaces a 409 version conflict as a tool error without re-applying', async () => {
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  let calls = 0;
  try {
    const client = planClient({
      update: async () => {
        calls++;
        return err(409, { code: 'SESSION_PLAN_VERSION_CONFLICT', error: 'expected version 2 but current is 3' });
      }
    });
    const result = await callPlanTool(client, 'project_plan_update', {
      requestId: 'idem_planupd00002',
      todoId: 'todo_cfl000000001',
      expectedVersion: 2,
      patch: { status: 'completed' }
    });

    expect(calls).toBe(1);
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: 'project_plan_update request failed: 409 SESSION_PLAN_VERSION_CONFLICT: expected version 2 but current is 3'
        }
      ],
      isError: true
    });
  } finally {
    stderr.mockRestore();
  }
});

test('a plan tool surfaces the daemon error code even when the client error is an Error instance (Eden shape)', async () => {
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    // Eden's real treaty error is an Error whose `.message` is String(body) === "[object Object]", with the
    // parsed body on `.value`. A plain-object fake never exercises that branch — this pins the real shape.
    const edenError = Object.assign(new Error('[object Object]'), {
      status: 403,
      value: { code: 'MESH_SESSION_NOT_CURRENT', error: 'runtime is not current', retryable: false }
    });
    const client = planClient({
      add: async () => ({ data: null, error: edenError, status: 403 })
    });
    const result = await callPlanTool(client, 'project_plan_add', { requestId: 'idem_planeden0001', text: 'fenced' });
    expect(result).toEqual({
      content: [
        { type: 'text', text: 'project_plan_add request failed: 403 MESH_SESSION_NOT_CURRENT: runtime is not current' }
      ],
      isError: true
    });
  } finally {
    stderr.mockRestore();
  }
});

test('project_plan_add surfaces a cross-project assignee rejection as a tool error', async () => {
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const client = planClient({
      add: async () => err(403, { code: 'ASSIGNEE_NOT_IN_PROJECT', error: 'assignee is not a member of this project' })
    });
    const result = await callPlanTool(client, 'project_plan_add', {
      requestId: 'idem_planadd00003',
      text: 'delegate',
      assigneeProjectMemberId: 'pmem_foreignmemb1'
    });
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: 'project_plan_add request failed: 403 ASSIGNEE_NOT_IN_PROJECT: assignee is not a member of this project'
        }
      ],
      isError: true
    });
  } finally {
    stderr.mockRestore();
  }
});

test('a plan tool fails closed when the runtime binding is unauthorized', async () => {
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const client = planClient({
      get: async () => err(404, { code: 'MESH_SESSION_NOT_FOUND', error: 'MeshAgent session not found' })
    });
    const result = await callPlanTool(client, 'project_plan_list', {});
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: 'project_plan_list request failed: 404 MESH_SESSION_NOT_FOUND: MeshAgent session not found'
        }
      ],
      isError: true
    });
  } finally {
    stderr.mockRestore();
  }
});

test('project_plan_add rejects forged session/actor attribution fields before calling the daemon', async () => {
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  let calls = 0;
  try {
    const client = planClient({
      add: async () => {
        calls++;
        return ok({ todo: {} });
      }
    });
    // sessionId and any actor attribution are daemon-derived; the strict wire schema rejects them at parse.
    const result = await callPlanTool(client, 'project_plan_add', {
      requestId: 'idem_planadd00004',
      text: 'forged',
      sessionId: 'ses_forged000001',
      actorProjectMemberId: 'pmem_impersonator'
    });

    expect(calls).toBe(0);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('sessionId');
  } finally {
    stderr.mockRestore();
  }
});

test('project_plan_add requires a requestId for idempotency', async () => {
  let calls = 0;
  const client = planClient({
    add: async () => {
      calls++;
      return ok({ todo: {} });
    }
  });
  const result = await callPlanTool(client, 'project_plan_add', { text: 'no request id' });
  expect(calls).toBe(0);
  expect(result).toEqual({
    content: [{ type: 'text', text: 'project_plan_add requires requestId for idempotency' }],
    isError: true
  });
});

test('project_plan_add caches the result by requestId so a replay never double-appends', async () => {
  let calls = 0;
  const client = planClient({
    add: async () => {
      calls++;
      return ok({ todo: { id: 'todo_onceonce001' } });
    }
  });
  const handler = createAgentFacingMcpHandler(client as never);
  const request = {
    jsonrpc: '2.0' as const,
    id: 1,
    method: 'tools/call',
    params: { name: 'project_plan_add', arguments: { requestId: 'idem_planadd00005', text: 'once' } }
  };
  const first = await handler.handle(request);
  const replay = await handler.handle({ ...request, id: 2 });
  if (!first || !('result' in first) || !replay || !('result' in replay)) throw new Error('expected results');

  expect(calls).toBe(1);
  expect(first.result).toEqual(replay.result);
  expect(first.result).toMatchObject({ isError: false });
});

test('project_plan_update scopes idempotency by payload: identical retry is cache-served, a different todo reaches the daemon guard', async () => {
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  const bodies: Array<{ requestId: string; todoId: string }> = [];
  try {
    // Mirror the daemon's session_plan_mutations ledger: a reused requestId carrying a different command
    // fingerprint is rejected as idempotency_conflict. The proxy must reach this guard, not mask it.
    const ledger = new Map<string, string>();
    const client = planClient({
      update: async (body) => {
        const b = body as { requestId: string; todoId: string; expectedVersion: number; patch: unknown };
        bodies.push({ requestId: b.requestId, todoId: b.todoId });
        const fingerprint = JSON.stringify([b.todoId, b.expectedVersion, b.patch]);
        const seen = ledger.get(b.requestId);
        if (seen !== undefined && seen !== fingerprint) {
          return err(409, {
            code: 'SESSION_PLAN_IDEMPOTENCY_CONFLICT',
            error: 'requestId reused with a different command'
          });
        }
        ledger.set(b.requestId, fingerprint);
        return ok({ todo: { id: b.todoId, version: b.expectedVersion + 1 } });
      }
    });
    const handler = createAgentFacingMcpHandler(client as never);
    const callA = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'tools/call',
      params: {
        name: 'project_plan_update',
        arguments: {
          requestId: 'idem_planupd00009',
          todoId: 'todo_aaa000000001',
          expectedVersion: 2,
          patch: { status: 'completed' }
        }
      }
    };
    const first = await handler.handle(callA);
    const identicalReplay = await handler.handle({ ...callA, id: 2 });
    if (!first || !('result' in first) || !identicalReplay || !('result' in identicalReplay)) {
      throw new Error('expected results');
    }
    // Identical payload + same requestId → served from the proxy cache; the daemon route is hit exactly once.
    expect(bodies).toEqual([{ requestId: 'idem_planupd00009', todoId: 'todo_aaa000000001' }]);
    expect(first.result).toEqual(identicalReplay.result);
    expect(first.result).toMatchObject({ isError: false });

    // Same requestId, DIFFERENT todo → not cache-served; it reaches the daemon, which rejects the reuse.
    const crossIntent = await handler.handle({
      ...callA,
      id: 3,
      params: {
        name: 'project_plan_update',
        arguments: {
          requestId: 'idem_planupd00009',
          todoId: 'todo_bbb000000001',
          expectedVersion: 4,
          patch: { status: 'pending' }
        }
      }
    });
    if (!crossIntent || !('result' in crossIntent)) throw new Error('expected result');
    expect(bodies).toEqual([
      { requestId: 'idem_planupd00009', todoId: 'todo_aaa000000001' },
      { requestId: 'idem_planupd00009', todoId: 'todo_bbb000000001' }
    ]);
    expect(crossIntent.result).toMatchObject({ isError: true });
    expect((crossIntent.result as { content: Array<{ text: string }> }).content[0]?.text).toContain(
      'SESSION_PLAN_IDEMPOTENCY_CONFLICT'
    );
  } finally {
    stderr.mockRestore();
  }
});

test('a plan mutation that fails transiently is not cached, so an identical retry reaches the daemon again', async () => {
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  let calls = 0;
  try {
    const client = planClient({
      add: async () => {
        calls++;
        if (calls === 1) return err(503, { code: 'UPSTREAM_UNAVAILABLE', error: 'daemon briefly unavailable' });
        return ok({ todo: { id: 'todo_retry0000001', version: 0 } });
      }
    });
    const handler = createAgentFacingMcpHandler(client as never);
    const request = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'tools/call',
      params: { name: 'project_plan_add', arguments: { requestId: 'idem_planretry012', text: 'ship it' } }
    };
    const first = await handler.handle(request);
    const retry = await handler.handle({ ...request, id: 2 });
    if (!first || !('result' in first) || !retry || !('result' in retry)) throw new Error('expected results');

    // The transient failure is surfaced but not cached: the identical retry hits the daemon a second time
    // (never the store-before-commit case pinned to a permanent error) and succeeds.
    expect((first.result as { isError: boolean }).isError).toBe(true);
    expect(calls).toBe(2);
    expect((retry.result as { isError: boolean }).isError).toBe(false);
    expect((retry.result as { content: Array<{ text: string }> }).content[0]?.text).toContain('todo_retry0000001');
  } finally {
    stderr.mockRestore();
  }
});

test('a plan mutation committed before a lost response replays from the daemon ledger on retry, never duplicating', async () => {
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
  const ledger = new Map<string, { todo: { id: string; version: number } }>();
  let committed = 0;
  let calls = 0;
  try {
    const client = planClient({
      add: async (body) => {
        calls++;
        const requestId = (body as { requestId: string }).requestId;
        let entry = ledger.get(requestId);
        if (!entry) {
          committed++;
          entry = { todo: { id: 'todo_commit000001', version: 0 } };
          ledger.set(requestId, entry);
        }
        // First response is lost after the commit; the daemon ledger replays the same todo on retry.
        if (calls === 1) return err(502, { code: 'RESPONSE_LOST', error: 'committed, response dropped in transit' });
        return ok(entry);
      }
    });
    const handler = createAgentFacingMcpHandler(client as never);
    const request = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'tools/call',
      params: { name: 'project_plan_add', arguments: { requestId: 'idem_plancommit12', text: 'commit once' } }
    };
    const first = await handler.handle(request);
    const retry = await handler.handle({ ...request, id: 2 });
    if (!first || !('result' in first) || !retry || !('result' in retry)) throw new Error('expected results');

    expect((first.result as { isError: boolean }).isError).toBe(true);
    expect(calls).toBe(2);
    expect(committed).toBe(1);
    expect((retry.result as { isError: boolean }).isError).toBe(false);
    expect((retry.result as { content: Array<{ text: string }> }).content[0]?.text).toContain('todo_commit000001');
  } finally {
    stderr.mockRestore();
  }
});
