// Offline wiring tests: drive endpoints through store.dispatch (no React render)
// against a fake treaty-backed client injected via the extraArgument. Proves
// the DI, queryFn delegation, error mapping, and tag-based invalidation.

import type { MonadClient } from '@monad/client';
import type { Event } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { getMeshAgentUsageApi } from '../../src/endpoints/mesh-agent/get-mesh-agent-usage.ts';
import { getNativeAgentDeliveryApi } from '../../src/endpoints/mesh-agent/get-native-agent-delivery.ts';
import { listMeshSessionsApi } from '../../src/endpoints/mesh-agent/list-mesh-sessions.ts';
import {
  getUiItemsApi,
  listSessionsApi,
  resetSessionApi,
  sessionAdapter,
  sessionSelectors,
  streamControlApi
} from '../../src/endpoints/sessions/index.ts';
import { updateSessionApi } from '../../src/endpoints/sessions/update-session.ts';
import { channelsApi } from '../../src/endpoints/settings/channels/index.ts';
import { listMcpServerStatusApi } from '../../src/endpoints/settings/mcp-servers/status-mcp-servers.ts';
import {
  createMonadStore,
  monadApi,
  useGetMeshAgentAuthQuery,
  useGetMeshAgentUsageQuery,
  useGetNativeAgentDeliveryQuery,
  useInputMeshAgentAuthMutation,
  useLazyGetMeshAgentAuthStatusQuery,
  useLazyGetMeshAgentUsageQuery,
  useLazyListCommandsQuery,
  useStartMeshAgentAuthMutation,
  useStopMeshAgentAuthMutation
} from '../../src/index.ts';

function ok<T>(data: T): { data: T; status: number } {
  return { data, status: 200 };
}

function fakeClient(overrides: Record<string, unknown>): MonadClient {
  const client = {
    treaty: {
      v1: {
        sessions: Object.assign(
          ({ id }: { id: string }) => ({
            patch: async (body: Record<string, unknown>) => {
              const fn = overrides.updateSession as
                | ((sessionId: string, body: Record<string, unknown>) => Promise<unknown>)
                | undefined;
              return ok({ session: fn ? await fn(id, body) : undefined });
            },
            messages: {
              get: async () => {
                const fn = overrides.getMessages as ((sessionId: string) => Promise<unknown[]>) | undefined;
                return ok({ messages: fn ? await fn(id) : [], total: 0 });
              },
              post: async ({ text }: { text: string }) => {
                const fn = overrides.sendMessage as ((sessionId: string, text: string) => Promise<void>) | undefined;
                if (fn) await fn(id, text);
                return { status: 200 };
              },
              block: {
                post: async ({ text }: { text: string }) => {
                  const fn = overrides.generate as
                    | ((sessionId: string, text: string) => Promise<{ id: string; text: string }>)
                    | undefined;
                  const message = fn ? await fn(id, text) : { id: 'msg_100000000000', text };
                  return ok({ message });
                }
              }
            },
            'ui-items': {
              get: async () => {
                const fn = overrides.getUiItems as ((sessionId: string) => Promise<unknown[]>) | undefined;
                return ok({ items: fn ? await fn(id) : [], nextCursor: undefined });
              }
            },
            reset: {
              post: async () => {
                const fn = overrides.resetSession as
                  | ((sessionId: string) => Promise<{ clearedCount: number }>)
                  | undefined;
                return ok(fn ? await fn(id) : { clearedCount: 0 });
              }
            }
          }),
          {
            get: async ({ query }: { query?: Record<string, unknown> } = {}) => {
              const fn = overrides.listSessions as
                | ((query?: Record<string, unknown>) => Promise<unknown[]>)
                | undefined;
              const sessions = fn ? await fn(query) : [];
              return ok({ sessions, total: sessions.length, limit: 50, offset: 0 });
            },
            post: async ({ title }: { title: string }) => {
              const fn = overrides.createSession as ((title: string) => Promise<string>) | undefined;
              return ok({ sessionId: fn ? await fn(title) : `ses_${title}` });
            }
          }
        ),
        mesh: {
          sessions: {
            get: async ({ query }: { query: { transcriptTargetId: string } }) => {
              const fn = overrides.listMeshSessions as ((sessionId: string) => Promise<unknown[]>) | undefined;
              return ok({ sessions: fn ? await fn(query.transcriptTargetId) : [] });
            }
          },
          agents: ({ name }: { name: string }) => ({
            usage: {
              get: async () => {
                const fn = overrides.getMeshAgentUsage as ((name: string) => Promise<unknown>) | undefined;
                return ok(
                  fn
                    ? await fn(name)
                    : {
                        agentName: name,
                        provider: 'codex',
                        checkedAt: '2026-07-03T00:00:00.000Z',
                        records: []
                      }
                );
              }
            }
          }),
          deliveries: ({ id }: { id: string }) => ({
            get: async () => {
              const fn = overrides.getNativeAgentDelivery as ((id: string) => Promise<unknown>) | undefined;
              return ok(
                fn
                  ? await fn(id)
                  : {
                      delivery: {
                        id,
                        sessionId: 'ses_01KDEFAUObDk',
                        memberInstanceId: 'pmem_codex',
                        meshSessionId: 'mesh_100000000000',
                        triggerMessageSeq: 1,
                        state: 'queued',
                        turn: {},
                        errorSummary: null,
                        createdAt: '2026-07-03T00:00:00.000Z'
                      }
                    }
              );
            }
          })
        },
        settings: {
          'mcp-servers': {
            status: {
              get: async () => {
                const fn = overrides.listMcpServerStatus as (() => Promise<unknown[]>) | undefined;
                return ok({ servers: fn ? await fn() : [] });
              }
            }
          },
          model: {
            providers: Object.assign(
              ({ id }: { id: string }) => ({
                credentials: Object.assign(
                  ({ credId }: { credId: string }) => ({
                    delete: async () => {
                      const fn = overrides.deleteCredential as
                        | ((providerId: string, credentialId: string) => Promise<void>)
                        | undefined;
                      if (fn) await fn(id, credId);
                      return { status: 200 };
                    },
                    test: {
                      post: async () => ok({ ok: true })
                    }
                  }),
                  {
                    get: async () => {
                      const fn = overrides.listCredentials as ((providerId: string) => Promise<unknown[]>) | undefined;
                      return ok({ credentials: fn ? await fn(id) : [] });
                    },
                    post: async (body: { label: string; authType: string; accessToken: string }) => {
                      const fn = overrides.addCredential as
                        | ((req: {
                            providerId: string;
                            label: string;
                            authType: string;
                            accessToken: string;
                          }) => Promise<string>)
                        | undefined;
                      const created = fn ? await fn({ providerId: id, ...body }) : 'cred_1';
                      return ok({ id: created });
                    }
                  }
                ),
                models: {
                  get: async () => ok({ models: [] })
                }
              }),
              {
                get: async () => {
                  const fn = overrides.listProviders as (() => Promise<unknown[]>) | undefined;
                  if (fn) return ok({ providers: await fn() });
                  return ok({ providers: [] });
                },
                put: async () => ({ status: 200 })
              }
            ),
            profiles: {
              get: async () => ok({ profiles: [], defaultAlias: '' }),
              put: async () => ({ status: 200 })
            },
            default: {
              get: async () => ok({ alias: '' }),
              put: async () => ({ status: 200 })
            },
            'test-connection': {
              post: async () => ok({ ok: true })
            }
          },
          channels: Object.assign(
            ({ id }: { id: string }) => ({
              delete: async () => {
                const fn = overrides.deleteChannel as ((id: string) => Promise<void>) | undefined;
                if (fn) await fn(id);
                return { status: 200 };
              },
              credential: {
                put: async ({ token }: { token: string }) => {
                  const fn = overrides.setChannelCredential as
                    | ((id: string, token: string) => Promise<void>)
                    | undefined;
                  if (fn) await fn(id, token);
                  return { status: 200 };
                }
              }
            }),
            {
              get: async () => {
                const fn = overrides.listChannels as (() => Promise<unknown[]>) | undefined;
                return ok({ channels: fn ? await fn() : [] });
              },
              put: async ({ channel }: { channel: unknown }) => {
                const fn = overrides.upsertChannel as ((channel: unknown) => Promise<void>) | undefined;
                if (fn) await fn(channel);
                return { status: 200 };
              },
              status: {
                get: async () => {
                  const fn = overrides.channelStatus as (() => Promise<unknown[]>) | undefined;
                  return ok({ statuses: fn ? await fn() : [] });
                }
              }
            }
          )
        }
      }
    },
    subscribeControl: (handler: (event: Event) => void) => {
      const fn = overrides.subscribeControl as ((h: (event: Event) => void) => () => void) | undefined;
      return fn ? fn(handler) : () => {};
    },
    streamEvents: () => () => {},
    streamUiEvents: () => () => {}
  };
  return client as unknown as MonadClient;
}

test('MeshAgent auth hooks are exported from the package API', () => {
  expect(typeof useGetNativeAgentDeliveryQuery).toBe('function');
  expect(typeof useGetMeshAgentAuthQuery).toBe('function');
  expect(typeof useGetMeshAgentUsageQuery).toBe('function');
  expect(typeof useInputMeshAgentAuthMutation).toBe('function');
  expect(typeof useLazyGetMeshAgentAuthStatusQuery).toBe('function');
  expect(typeof useLazyListCommandsQuery).toBe('function');
  expect(typeof useLazyGetMeshAgentUsageQuery).toBe('function');
  expect(typeof useStartMeshAgentAuthMutation).toBe('function');
  expect(typeof useStopMeshAgentAuthMutation).toBe('function');
});

test('getMeshAgentUsage uses the typed MeshAgent usage treaty route', async () => {
  const seen: string[] = [];
  const client = fakeClient({
    getMeshAgentUsage: async (name: string) => {
      seen.push(name);
      return {
        agentName: name,
        provider: 'codex',
        checkedAt: '2026-07-03T00:00:00.000Z',
        records: [{ name: 'daily', max: 100, current: 12 }]
      };
    }
  });
  const store = createMonadStore({ client });

  const res = await store.dispatch(
    (
      getMeshAgentUsageApi.endpoints as typeof getMeshAgentUsageApi.endpoints & {
        getMeshAgentUsage: {
          initiate: typeof getMeshAgentUsageApi.endpoints.getMeshAgentUsage.initiate;
        };
      }
    ).getMeshAgentUsage.initiate('codex')
  );

  expect(seen).toEqual(['codex']);
  expect('data' in res && res.data?.records).toEqual([{ name: 'daily', max: 100, current: 12 }]);
});

test('getNativeAgentDelivery uses the typed native agent delivery treaty route', async () => {
  const seen: string[] = [];
  const client = fakeClient({
    getNativeAgentDelivery: async (id: string) => {
      seen.push(id);
      return {
        delivery: {
          id,
          sessionId: 'ses_01KCLIENcYUg',
          memberInstanceId: 'pmem_codex_1',
          meshSessionId: 'mesh_100000000000',
          triggerMessageSeq: 7,
          state: 'delivered',
          turn: { providerSessionRef: 'provider-session-1', providerTurnId: 'turn-1' },
          errorSummary: null,
          createdAt: '2026-07-03T00:00:00.000Z',
          updatedAt: '2026-07-03T00:00:01.000Z'
        }
      };
    }
  });
  const store = createMonadStore({ client });

  const res = await store.dispatch(
    (
      getNativeAgentDeliveryApi.endpoints as typeof getNativeAgentDeliveryApi.endpoints & {
        getNativeAgentDelivery: {
          initiate: typeof getNativeAgentDeliveryApi.endpoints.getNativeAgentDelivery.initiate;
        };
      }
    ).getNativeAgentDelivery.initiate({
      id: 'deliv_01KCLIENU7u7',
      transcriptTargetId: 'ses_01KCLIENcYUg'
    })
  );

  expect(seen).toEqual(['deliv_01KCLIENU7u7']);
  expect('data' in res && res.data?.delivery.state).toBe('delivered');
  expect('data' in res && res.data?.delivery.turn.providerTurnId).toBe('turn-1');
});

test('a query delegates to the client and caches by tag', async () => {
  let calls = 0;
  const client = fakeClient({
    listSessions: async () => {
      calls++;
      return [
        {
          id: 'ses_100000000000',
          title: 't',
          state: 'active',
          agentIds: [],
          archived: false,
          restoreCount: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ];
    }
  });
  const store = createMonadStore({ client });

  const res = await store.dispatch(monadApi.endpoints.listSessions.initiate(undefined));
  expect(sessionSelectors.selectAll(res.data?.sessions ?? sessionAdapter.getInitialState())[0]?.id).toBe(
    'ses_100000000000'
  );
  expect(calls).toBe(1);

  // Second subscriber hits the cache — no extra client call.
  await store.dispatch(monadApi.endpoints.listSessions.initiate(undefined));
  expect(calls).toBe(1);
});

test('listSessions forwards the server search query and archived scope', async () => {
  let receivedQuery: Record<string, unknown> | undefined;
  const client = fakeClient({
    listSessions: async (query: Record<string, unknown> | undefined) => {
      receivedQuery = query;
      return [];
    }
  });
  const store = createMonadStore({ client });

  await store.dispatch(
    monadApi.endpoints.listSessions.initiate({ archived: true, query: 'runtime', limit: 20, offset: 0 })
  );

  expect(receivedQuery).toEqual({ archived: true, query: 'runtime', limit: 20, offset: 0 });
});

test('unarchiving moves a session between scoped list caches before the request resolves', async () => {
  let archived = true;
  let resolveUpdate: ((value: unknown) => void) | undefined;
  const session = {
    id: 'ses_archived00001' as const,
    title: 'Archived session',
    state: 'active' as const,
    agentIds: [],
    archived,
    restoreCount: 0,
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z'
  };
  const client = fakeClient({
    listSessions: async (query: Record<string, unknown> | undefined) =>
      query?.archived === archived ? [{ ...session, archived }] : [],
    updateSession: async () =>
      new Promise((resolve) => {
        resolveUpdate = resolve;
      })
  });
  const store = createMonadStore({ client });
  const activeArgs = { archived: false };
  const archivedArgs = { archived: true };
  await store.dispatch(listSessionsApi.endpoints.listSessions.initiate(activeArgs));
  await store.dispatch(listSessionsApi.endpoints.listSessions.initiate(archivedArgs));

  const mutation = store.dispatch(
    updateSessionApi.endpoints.updateSession.initiate({ id: session.id, archived: false })
  );
  const activeData = listSessionsApi.endpoints.listSessions.select(activeArgs)(store.getState() as never).data;
  const archivedData = listSessionsApi.endpoints.listSessions.select(archivedArgs)(store.getState() as never).data;

  expect(
    sessionSelectors.selectAll(activeData?.sessions ?? sessionAdapter.getInitialState()).map((item) => item.id)
  ).toEqual([session.id]);
  expect(
    sessionSelectors.selectAll(archivedData?.sessions ?? sessionAdapter.getInitialState()).map((item) => item.id)
  ).toEqual([]);

  archived = false;
  resolveUpdate?.({ ...session, archived: false });
  await mutation;
});

test('createSession invalidates Sessions, forcing a refetch', async () => {
  let listCalls = 0;
  const client = fakeClient({
    listSessions: async () => {
      listCalls++;
      return [];
    },
    createSession: async () => 'ses_x00000000000'
  });
  const store = createMonadStore({ client });

  await store.dispatch(monadApi.endpoints.listSessions.initiate(undefined));
  expect(listCalls).toBe(1);

  const created = await store.dispatch(monadApi.endpoints.createSession.initiate({ title: 'x' }));
  expect('data' in created && created.data).toBe('ses_x00000000000');

  // The Sessions tag was invalidated; the still-subscribed query refetches.
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  expect(listCalls).toBe(2);
});

test('client errors surface on the RTKQ error branch, not as throws', async () => {
  const client = fakeClient({
    listProviders: async () => {
      throw new Error('boom');
    }
  });
  const store = createMonadStore({ client });

  const res = await store.dispatch(monadApi.endpoints.listProviders.initiate(undefined));
  expect((res.error as { message?: string } | undefined)?.message).toBe('boom');
});

test('listMeshSessions uses the typed session treaty route', async () => {
  const seen: string[] = [];
  const now = new Date().toISOString();
  const client = fakeClient({
    listMeshSessions: async (sessionId: string) => {
      seen.push(sessionId);
      return [
        {
          id: 'mesh_100000000000',
          sessionId: sessionId,
          agentName: 'codex',
          provider: 'codex',
          workingPath: '/tmp/project',
          approvalOwnership: 'provider-owned',
          runtimeRole: 'managed-project-agent',
          lastDeliveredSeq: 0,
          lastVisibleSeq: 0,
          pendingApprovalCount: 0,
          lifecycle: { state: 'active' },
          activity: { state: 'running', pid: 123, queuedTurnCount: 0 },
          connection: { state: 'connected' },
          capabilities: {
            input: true,
            steer: false,
            interrupt: false,
            approvalResolution: false,
            providerSessionContinuation: true,
            runtimeRestoration: true,
            sessionReopen: true
          },
          startedAt: now,
          updatedAt: now
        }
      ];
    }
  });
  const store = createMonadStore({ client });

  const res = await store.dispatch(
    (
      listMeshSessionsApi.endpoints as typeof listMeshSessionsApi.endpoints & {
        listMeshSessions: {
          initiate: (id: string) => ReturnType<typeof listMeshSessionsApi.endpoints.listMeshSessions.initiate>;
        };
      }
    ).listMeshSessions.initiate('ses_100000000000')
  );

  expect(seen).toEqual(['ses_100000000000']);
  expect('data' in res && res.data?.ids).toEqual(['mesh_100000000000']);
});

test('credential mutations invalidate that provider’s credential list', async () => {
  let credCalls = 0;
  const client = fakeClient({
    listCredentials: async () => {
      credCalls++;
      return [];
    },
    addCredential: async () => 'cred_1'
  });
  const store = createMonadStore({ client });

  await store.dispatch(monadApi.endpoints.listCredentials.initiate('oai'));
  expect(credCalls).toBe(1);

  await store.dispatch(
    monadApi.endpoints.addCredential.initiate({
      providerId: 'oai',
      label: 'k',
      authType: 'api_key',
      accessToken: 'sk-x'
    })
  );
  await new Promise((r) => setTimeout(r, 0));
  expect(credCalls).toBe(2);
});

test('resetSession invalidates transcript windows and Sessions, forcing refetches', async () => {
  let uiItemCalls = 0;
  let sessionCalls = 0;
  const client = fakeClient({
    getUiItems: async () => {
      uiItemCalls++;
      return [];
    },
    listSessions: async () => {
      sessionCalls++;
      return [];
    },
    resetSession: async () => ({ clearedCount: 1 })
  });
  const store = createMonadStore({ client });

  await store.dispatch(getUiItemsApi.endpoints.getUiItemsWindow.initiate({ sessionId: 'ses_abc000000000' }));
  await store.dispatch(listSessionsApi.endpoints.listSessions.initiate(undefined));
  expect(uiItemCalls).toBe(1);
  expect(sessionCalls).toBe(1);

  await store.dispatch(resetSessionApi.endpoints.resetSession.initiate('ses_abc000000000'));
  await new Promise((r) => setTimeout(r, 0));
  expect(uiItemCalls).toBe(2);
  expect(sessionCalls).toBe(2);
});

test('streamControl subscribes to the control stream and invalidates Sessions on list events', async () => {
  let listCalls = 0;
  let controlHandler: ((event: Event) => void) | undefined;

  const client = fakeClient({
    listSessions: async () => {
      listCalls++;
      return [];
    },
    subscribeControl: (handler: (event: Event) => void) => {
      controlHandler = handler;
      return () => {};
    }
  });
  const store = createMonadStore({ client });

  await store.dispatch(monadApi.endpoints.listSessions.initiate(undefined));
  expect(listCalls).toBe(1);

  // Subscribing to the control stream triggers onCacheEntryAdded.
  store.dispatch(streamControlApi.endpoints.streamControl.initiate());
  await new Promise((r) => setTimeout(r, 0));

  // A SESSION_LIST_EVENT triggers a Sessions tag invalidation → listSessions refetches.
  controlHandler?.({
    id: 'evt_100000000000',
    sessionId: 'ses_100000000000',
    type: 'session.created',
    actorAgentId: null,
    payload: {},
    at: ''
  });
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  expect(listCalls).toBe(2);

  // A non-list event must NOT trigger a refetch.
  controlHandler?.({
    id: 'evt_200000000000',
    sessionId: 'ses_100000000000',
    type: 'tool.called',
    actorAgentId: null,
    payload: {},
    at: ''
  });
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  expect(listCalls).toBe(2);
});

test('streamControl invalidates MeshAgent sessions when a managed MeshAgent runtime starts', async () => {
  let meshAgentCalls = 0;
  let controlHandler: ((event: Event) => void) | undefined;
  const now = new Date().toISOString();

  const client = fakeClient({
    listMeshSessions: async (sessionId: string) => {
      meshAgentCalls++;
      return [
        {
          id: 'mesh_100000000000',
          sessionId: sessionId,
          agentName: 'pmem_codex_reviewer',
          provider: 'codex',
          workingPath: '/tmp/project',
          approvalOwnership: 'provider-owned',
          runtimeRole: 'managed-project-agent',
          lastDeliveredSeq: 0,
          lastVisibleSeq: 0,
          pendingApprovalCount: 0,
          lifecycle: { state: 'active' },
          activity: { state: 'running', pid: 123, queuedTurnCount: 0 },
          connection: { state: 'connected' },
          capabilities: {
            input: true,
            steer: false,
            interrupt: false,
            approvalResolution: false,
            providerSessionContinuation: true,
            runtimeRestoration: true,
            sessionReopen: true
          },
          startedAt: now,
          updatedAt: now
        }
      ];
    },
    subscribeControl: (handler: (event: Event) => void) => {
      controlHandler = handler;
      return () => {};
    }
  });
  const store = createMonadStore({ client });

  await store.dispatch(
    (
      listMeshSessionsApi.endpoints as typeof listMeshSessionsApi.endpoints & {
        listMeshSessions: {
          initiate: (id: string) => ReturnType<typeof listMeshSessionsApi.endpoints.listMeshSessions.initiate>;
        };
      }
    ).listMeshSessions.initiate('ses_100000000000')
  );
  expect(meshAgentCalls).toBe(1);

  store.dispatch(streamControlApi.endpoints.streamControl.initiate());
  await new Promise((r) => setTimeout(r, 0));

  controlHandler?.({
    id: 'evt_externals3NK',
    sessionId: 'ses_100000000000',
    type: 'mesh.started',
    actorAgentId: null,
    payload: { meshSessionId: 'mesh_100000000000' },
    at: ''
  });
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));

  expect(meshAgentCalls).toBe(2);
});

test('streamControl invalidates MCP server status when MCP status changes', async () => {
  let statusCalls = 0;
  let controlHandler: ((event: Event) => void) | undefined;

  const client = fakeClient({
    listMcpServerStatus: async () => {
      statusCalls++;
      return [
        {
          name: 'fs',
          source: 'config',
          transport: 'stdio',
          state: statusCalls === 1 ? 'starting' : 'ready',
          toolCount: statusCalls === 1 ? 0 : 1,
          tools: statusCalls === 1 ? [] : ['fs__read']
        }
      ];
    },
    subscribeControl: (handler: (event: Event) => void) => {
      controlHandler = handler;
      return () => {};
    }
  });
  const store = createMonadStore({ client });

  await store.dispatch(listMcpServerStatusApi.endpoints.listMcpServerStatus.initiate());
  expect(statusCalls).toBe(1);

  store.dispatch(streamControlApi.endpoints.streamControl.initiate());
  await new Promise((r) => setTimeout(r, 0));

  controlHandler?.({
    id: 'evt_mcpstatus000',
    sessionId: 'ses_mcpstatus000',
    type: 'mcp.status_updated',
    actorAgentId: null,
    payload: {},
    at: ''
  });
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));

  expect(statusCalls).toBe(2);
});

test('listChannels caches by the Channels tag', async () => {
  let calls = 0;
  const client = fakeClient({
    listChannels: async () => {
      calls++;
      return [];
    }
  });
  const store = createMonadStore({ client });

  await store.dispatch(channelsApi.endpoints.listChannels.initiate(undefined));
  expect(calls).toBe(1);

  // Second dispatch hits the cache.
  await store.dispatch(channelsApi.endpoints.listChannels.initiate(undefined));
  expect(calls).toBe(1);
});

test('channel mutations all invalidate Channels, forcing a refetch', async () => {
  let listCalls = 0;
  const client = fakeClient({
    listChannels: async () => {
      listCalls++;
      return [];
    },
    upsertChannel: async () => {},
    deleteChannel: async () => {},
    setChannelCredential: async () => {}
  });
  const store = createMonadStore({ client });

  await store.dispatch(channelsApi.endpoints.listChannels.initiate(undefined));
  expect(listCalls).toBe(1);

  const channel = {
    id: 'chn_100000000000',
    type: 'telegram',
    label: 'My Bot',
    enabled: true,
    options: {},
    allowlist: { allowAllUsers: false, allowedUsers: [] },
    mapping: { granularity: 'per-conversation' as const },
    rateLimitPerMin: 20
  };

  await store.dispatch(channelsApi.endpoints.upsertChannel.initiate(channel as never));
  await new Promise((r) => setTimeout(r, 0));
  expect(listCalls).toBe(2);

  await store.dispatch(channelsApi.endpoints.deleteChannel.initiate('chn_100000000000'));
  await new Promise((r) => setTimeout(r, 0));
  expect(listCalls).toBe(3);

  await store.dispatch(channelsApi.endpoints.setChannelCredential.initiate({ id: 'chn_100000000000', token: 'tok_x' }));
  await new Promise((r) => setTimeout(r, 0));
  expect(listCalls).toBe(4);
});
