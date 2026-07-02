// Offline wiring tests: drive endpoints through store.dispatch (no React render)
// against a fake treaty-backed client injected via the extraArgument. Proves
// the DI, queryFn delegation, error mapping, and tag-based invalidation.

import type { MonadClient } from '@monad/client';
import type { Event } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { listNativeCliSessionsApi } from '../../src/endpoints/native-cli/list-native-cli-sessions.ts';
import {
  getMessagesApi,
  listSessionsApi,
  resetSessionApi,
  sessionAdapter,
  sessionSelectors,
  streamControlApi,
  streamUiItemsApi
} from '../../src/endpoints/sessions/index.ts';
import { channelsApi } from '../../src/endpoints/settings/channels/index.ts';
import {
  createMonadStore,
  monadApi,
  useGetNativeCliAuthQuery,
  useInputNativeCliAuthMutation,
  useLazyGetNativeCliAuthStatusQuery,
  useStartNativeCliAuthMutation,
  useStopNativeCliAuthMutation
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
                  const message = fn ? await fn(id, text) : { id: 'msg_1', text };
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
            'native-cli-sessions': {
              get: async () => {
                const fn = overrides.listNativeCliSessions as ((sessionId: string) => Promise<unknown[]>) | undefined;
                return ok({ sessions: fn ? await fn(id) : [] });
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
            get: async () => {
              const fn = overrides.listSessions as (() => Promise<unknown[]>) | undefined;
              const sessions = fn ? await fn() : [];
              return ok({ sessions, total: sessions.length, limit: 50, offset: 0 });
            },
            post: async ({ title }: { title: string }) => {
              const fn = overrides.createSession as ((title: string) => Promise<string>) | undefined;
              return ok({ sessionId: fn ? await fn(title) : `ses_${title}` });
            }
          }
        ),
        projects: ({ id }: { id: string }) => ({
          'native-cli-sessions': {
            get: async () => {
              const fn = overrides.listProjectNativeCliSessions as
                | ((projectId: string) => Promise<unknown[]>)
                | undefined;
              return ok({ sessions: fn ? await fn(id) : [] });
            }
          }
        }),
        settings: {
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

test('native CLI auth hooks are exported from the package API', () => {
  expect(typeof useGetNativeCliAuthQuery).toBe('function');
  expect(typeof useInputNativeCliAuthMutation).toBe('function');
  expect(typeof useLazyGetNativeCliAuthStatusQuery).toBe('function');
  expect(typeof useStartNativeCliAuthMutation).toBe('function');
  expect(typeof useStopNativeCliAuthMutation).toBe('function');
});

test('a query delegates to the client and caches by tag', async () => {
  let calls = 0;
  const client = fakeClient({
    listSessions: async () => {
      calls++;
      return [
        {
          id: 'ses_1',
          title: 't',
          ownerPrincipalId: 'prn_TEST',
          state: 'active',
          agentIds: [],
          parentSessionId: null,
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
  expect(sessionSelectors.selectAll(res.data?.sessions ?? sessionAdapter.getInitialState())[0]?.id).toBe('ses_1');
  expect(calls).toBe(1);

  // Second subscriber hits the cache — no extra client call.
  await store.dispatch(monadApi.endpoints.listSessions.initiate(undefined));
  expect(calls).toBe(1);
});

test('createSession invalidates Sessions, forcing a refetch', async () => {
  let listCalls = 0;
  const client = fakeClient({
    listSessions: async () => {
      listCalls++;
      return [];
    },
    createSession: async (title: string) => `ses_${title}`
  });
  const store = createMonadStore({ client });

  await store.dispatch(monadApi.endpoints.listSessions.initiate(undefined));
  expect(listCalls).toBe(1);

  const created = await store.dispatch(monadApi.endpoints.createSession.initiate({ title: 'x' }));
  expect('data' in created && created.data).toBe('ses_x');

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
  expect(res.data).toBeUndefined();
  expect((res.error as { message?: string } | undefined)?.message).toBe('boom');
});

test('listNativeCliSessions uses the typed project treaty route for Workplace Projects', async () => {
  const seen: string[] = [];
  const now = new Date().toISOString();
  const client = fakeClient({
    listProjectNativeCliSessions: async (projectId: string) => {
      seen.push(projectId);
      return [
        {
          id: 'ncli_1',
          transcriptTargetId: projectId,
          agentName: 'codex',
          provider: 'codex',
          workingPath: '/tmp/project',
          launchMode: 'app-server',
          runtimeRole: 'managed-project-agent',
          state: 'running',
          pid: 123,
          outputSnapshot: '',
          exitCode: null,
          startedAt: now,
          updatedAt: now,
          exitedAt: null
        }
      ];
    }
  });
  const store = createMonadStore({ client });

  const res = await store.dispatch(
    (
      listNativeCliSessionsApi.endpoints as typeof listNativeCliSessionsApi.endpoints & {
        listNativeCliSessions: {
          initiate: (
            id: string
          ) => ReturnType<typeof listNativeCliSessionsApi.endpoints.listNativeCliSessions.initiate>;
        };
      }
    ).listNativeCliSessions.initiate('prj_1')
  );

  expect(seen).toEqual(['prj_1']);
  expect('data' in res && res.data?.ids).toEqual(['ncli_1']);
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

test('resetSession invalidates Messages and Sessions, forcing refetches', async () => {
  let msgCalls = 0;
  let sessionCalls = 0;
  const client = fakeClient({
    getMessages: async () => {
      msgCalls++;
      return [];
    },
    listSessions: async () => {
      sessionCalls++;
      return [];
    },
    resetSession: async () => ({ clearedCount: 1 })
  });
  const store = createMonadStore({ client });

  await store.dispatch(getMessagesApi.endpoints.getMessages.initiate('ses_abc'));
  await store.dispatch(listSessionsApi.endpoints.listSessions.initiate(undefined));
  expect(msgCalls).toBe(1);
  expect(sessionCalls).toBe(1);

  await store.dispatch(resetSessionApi.endpoints.resetSession.initiate('ses_abc'));
  await new Promise((r) => setTimeout(r, 0));
  expect(msgCalls).toBe(2);
  expect(sessionCalls).toBe(2);
});

test('resetSession clears the live stream cache immediately', async () => {
  // History pages now live in component state (the Chat accumulator), so reset only needs to
  // clear the live stream cache optimistically; invalidatesTags('Messages') drops cached pages.
  const summaryItem = {
    kind: 'memory_summary',
    id: 'memory-summary:msg_1',
    summary: 'Earlier context.',
    uptoMessageId: 'msg_1',
    seq: 'msg_1'
  } as const;
  const client = fakeClient({ resetSession: async () => ({ clearedCount: 1 }) });
  const store = createMonadStore({ client });

  await store.dispatch(
    streamUiItemsApi.util.upsertQueryData('streamUiItems', 'ses_abc', { items: [summaryItem] }) as never
  );
  expect(streamUiItemsApi.endpoints.streamUiItems.select('ses_abc')(store.getState() as never).data?.items).toEqual([
    summaryItem
  ]);

  await store.dispatch(resetSessionApi.endpoints.resetSession.initiate('ses_abc'));

  const uiStream = streamUiItemsApi.endpoints.streamUiItems.select('ses_abc')(store.getState() as never);
  expect(uiStream.data?.items).toEqual([]);
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
  expect(controlHandler).toBeDefined();

  // A SESSION_LIST_EVENT triggers a Sessions tag invalidation → listSessions refetches.
  controlHandler?.({
    id: 'evt_1',
    transcriptTargetId: 'ses_1',
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
    id: 'evt_2',
    transcriptTargetId: 'ses_1',
    type: 'tool.called',
    actorAgentId: null,
    payload: {},
    at: ''
  });
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  expect(listCalls).toBe(2);
});

test('streamControl invalidates native CLI sessions when a project native CLI runtime starts', async () => {
  let nativeCliCalls = 0;
  let controlHandler: ((event: Event) => void) | undefined;
  const now = new Date().toISOString();

  const client = fakeClient({
    listProjectNativeCliSessions: async (projectId: string) => {
      nativeCliCalls++;
      return [
        {
          id: 'ncli_1',
          transcriptTargetId: projectId,
          agentName: 'pmem_codex_reviewer',
          provider: 'codex',
          workingPath: '/tmp/project',
          launchMode: 'app-server',
          runtimeRole: 'managed-project-agent',
          state: 'running',
          pid: 123,
          outputSnapshot: '',
          exitCode: null,
          startedAt: now,
          updatedAt: now,
          exitedAt: null
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
      listNativeCliSessionsApi.endpoints as typeof listNativeCliSessionsApi.endpoints & {
        listNativeCliSessions: {
          initiate: (
            id: string
          ) => ReturnType<typeof listNativeCliSessionsApi.endpoints.listNativeCliSessions.initiate>;
        };
      }
    ).listNativeCliSessions.initiate('prj_1')
  );
  expect(nativeCliCalls).toBe(1);

  store.dispatch(streamControlApi.endpoints.streamControl.initiate());
  await new Promise((r) => setTimeout(r, 0));
  expect(controlHandler).toBeDefined();

  controlHandler?.({
    id: 'evt_native_cli_started',
    transcriptTargetId: 'prj_1',
    type: 'native_cli.started',
    actorAgentId: null,
    payload: { nativeCliSessionId: 'ncli_1' },
    at: ''
  });
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));

  expect(nativeCliCalls).toBe(2);
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
    id: 'chn_1',
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

  await store.dispatch(channelsApi.endpoints.deleteChannel.initiate('chn_1'));
  await new Promise((r) => setTimeout(r, 0));
  expect(listCalls).toBe(3);

  await store.dispatch(channelsApi.endpoints.setChannelCredential.initiate({ id: 'chn_1', token: 'tok_x' }));
  await new Promise((r) => setTimeout(r, 0));
  expect(listCalls).toBe(4);
});
