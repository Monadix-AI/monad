// Offline wiring tests for the feature endpoints added for web-UI parity (usage reset, clarify,
// session branch/restore and atom-pack management). Same approach as api.test.ts: drive
// endpoints through store.dispatch against a fake treaty-backed client, asserting delegation,
// response shaping, and tag-based invalidation — no React render, no live daemon.

import type { MonadClient } from '@monad/client';

import { expect, test } from 'bun:test';

import { atomsApi } from '../../src/endpoints/atoms/index.ts';
import { branchSessionApi, resolveUiMessagesApi, restoreSessionApi } from '../../src/endpoints/sessions/index.ts';
import { clarifyRespondApi } from '../../src/endpoints/tools/clarify-respond.ts';
import { getUsageApi } from '../../src/endpoints/usage/get-usage.ts';
import { resetUsageApi } from '../../src/endpoints/usage/reset-usage.ts';
import { createMonadStore } from '../../src/index.ts';

function ok<T>(data: T): { data: T; status: number } {
  return { data, status: 200 };
}

interface Calls {
  usageGet: number;
  atomsList: number;
  workplaceExperiencesList: number;
  resolveUiMessages: number;
}

function fakeClient(overrides: Record<string, unknown>, calls: Calls): MonadClient {
  const client = {
    treaty: {
      v1: {
        usage: {
          get: async () => {
            calls.usageGet++;
            return ok({
              totalCostUsd: 0,
              totalInputTokens: 0,
              totalOutputTokens: 0,
              entries: [],
              breakdown: []
            });
          },
          reset: { post: async () => ok({ ok: true }) }
        },
        clarifications: {
          respond: {
            post: async (body: { requestId: string; answer: string }) => {
              const fn = overrides.clarifyRespond as
                | ((req: { requestId: string; answer: string }) => Promise<void>)
                | undefined;
              if (fn) await fn(body);
              return ok({ status: 'answered' as const, answer: body.answer, resolvedAt: '2026-07-21T00:00:00.000Z' });
            }
          }
        },
        sessions: ({ id }: { id: string }) => ({
          branch: {
            post: async (body: { atMessageId?: string }) => {
              const fn = overrides.branch as ((sessionId: string, atMessageId?: string) => Promise<string>) | undefined;
              return ok({ sessionId: fn ? await fn(id, body.atMessageId) : `undefined${id}` });
            }
          },
          restore: {
            post: async (body: { toMessageId: string }) => {
              const fn = overrides.restore as ((sessionId: string, toMessageId: string) => Promise<void>) | undefined;
              if (fn) await fn(id, body.toMessageId);
              return ok({ restoredCount: 1, newHeadMessageId: body.toMessageId });
            }
          },
          'ui-messages': {
            resolve: {
              post: async (body: { messageIds: string[] }) => {
                calls.resolveUiMessages++;
                const fn = overrides.resolveUiMessages as
                  | ((sessionId: string, messageIds: string[]) => Promise<{ items: unknown[] }>)
                  | undefined;
                return ok(
                  fn
                    ? await fn(id, body.messageIds)
                    : {
                        items: body.messageIds.map((messageId) => ({
                          kind: 'message' as const,
                          id: messageId,
                          role: 'assistant' as const,
                          parts: [{ type: 'text' as const, text: 'resolved' }],
                          replyable: true,
                          status: 'done' as const,
                          seq: '2026-07-21T00:00:00.000Z'
                        }))
                      }
                );
              }
            }
          }
        }),
        atoms: Object.assign(
          ({ name }: { name: string }) => ({
            enable: { post: async () => ok({ ok: true }) },
            disable: { post: async () => ok({ ok: true }) },
            update: {
              get: async () => {
                const fn = overrides.checkAtomPackUpdate as ((name: string) => Promise<void>) | undefined;
                if (fn) await fn(name);
                return ok({
                  name,
                  source: 'local:/pack',
                  sourceKind: 'local',
                  currentVersion: '1.0.0',
                  latestVersion: '2.0.0',
                  currentRevision: 'old',
                  latestRevision: 'new',
                  hasUpdate: true
                });
              },
              post: async () => {
                const fn = overrides.updateAtomPack as ((name: string) => Promise<void>) | undefined;
                if (fn) await fn(name);
                return ok({ name, atoms: ['channel'], warnings: [] });
              }
            },
            delete: async () => {
              const fn = overrides.removeAtom as ((name: string) => Promise<void>) | undefined;
              if (fn) await fn(name);
              return ok({ ok: true });
            }
          }),
          {
            get: async () => {
              calls.atomsList++;
              return ok({ atomPacks: [] });
            },
            'workplace-experiences': {
              get: async () => {
                calls.workplaceExperiencesList++;
                return ok({
                  experiences: [
                    {
                      id: 'canvas',
                      title: 'Canvas',
                      entry: { type: 'web-component', module: './canvas.js', tagName: 'monad-canvas' }
                    }
                  ]
                });
              }
            },
            install: {
              post: async (body: { source: string; consent: boolean }) => {
                // Default-deny: without consent the daemon asks for it (no install committed).
                if (!body.consent) {
                  return ok({ name: 'pack', atoms: ['tool'], needsConsent: true, warnings: ['reads files'] });
                }
                return ok({ name: 'pack', atoms: ['tool'], warnings: [] });
              }
            }
          }
        ),
        settings: {
          model: {
            'atom-kinds': {
              get: async () => ok({ kinds: ['tool', 'provider'] }),
              discover: { post: async () => ok({ registered: ['pack'], errors: [] }) }
            }
          }
        }
      }
    },
    subscribeControl: () => () => {},
    streamEvents: () => () => {}
  };
  return client as unknown as MonadClient;
}

test('resetUsage invalidates Usage, forcing the ledger to refetch', async () => {
  const calls: Calls = { usageGet: 0, atomsList: 0, workplaceExperiencesList: 0, resolveUiMessages: 0 };
  const store = createMonadStore({ client: fakeClient({}, calls) });

  await store.dispatch(getUsageApi.endpoints.getUsage.initiate(undefined));
  expect(calls.usageGet).toBe(1);

  await store.dispatch(resetUsageApi.endpoints.resetUsage.initiate());
  await new Promise((r) => setTimeout(r, 0));
  expect(calls.usageGet).toBe(2);
});

test('clarifyRespond delegates the answer and returns the terminal state', async () => {
  let seen: { requestId: string; answer: string } | undefined;
  const calls: Calls = { usageGet: 0, atomsList: 0, workplaceExperiencesList: 0, resolveUiMessages: 0 };
  const store = createMonadStore({
    client: fakeClient(
      {
        clarifyRespond: async (req: { requestId: string; answer: string }) => {
          seen = req;
        }
      },
      calls
    )
  });

  const res = await store.dispatch(
    clarifyRespondApi.endpoints.clarifyRespond.initiate({ requestId: 'clarify_1', answer: 'yes' })
  );
  expect('data' in res && res.data?.status).toBe('answered');
  expect(seen).toEqual({ requestId: 'clarify_1', answer: 'yes' });
});

test('branchSession returns the child id and passes the message checkpoint', async () => {
  let branchedAt: string | undefined;
  const calls: Calls = { usageGet: 0, atomsList: 0, workplaceExperiencesList: 0, resolveUiMessages: 0 };
  const store = createMonadStore({
    client: fakeClient(
      {
        branch: async (_sid: string, atMessageId?: string) => {
          branchedAt = atMessageId;
          return 'ses_child0000000';
        }
      },
      calls
    )
  });

  const res = await store.dispatch(
    branchSessionApi.endpoints.branchSession.initiate({
      id: 'ses_100000000000' as never,
      atMessageId: 'msg_500000000000' as never
    })
  );
  expect('data' in res && res.data?.sessionId).toBe('ses_child0000000');
  expect(branchedAt).toBe('msg_500000000000');
});

test('restoreSession returns the restored count and new head', async () => {
  const calls: Calls = { usageGet: 0, atomsList: 0, workplaceExperiencesList: 0, resolveUiMessages: 0 };
  const store = createMonadStore({ client: fakeClient({}, calls) });

  const res = await store.dispatch(
    restoreSessionApi.endpoints.restoreSession.initiate({
      id: 'ses_100000000000' as never,
      toMessageId: 'msg_300000000000' as never
    })
  );
  expect('data' in res && res.data?.restoredCount).toBe(1);
  expect('data' in res && res.data?.newHeadMessageId).toBe('msg_300000000000');
});

test('resolveUiMessages caches lookup-only results by the ordered request identity', async () => {
  const requests: Array<{ sessionId: string; messageIds: string[] }> = [];
  const calls: Calls = { usageGet: 0, atomsList: 0, workplaceExperiencesList: 0, resolveUiMessages: 0 };
  const store = createMonadStore({
    client: fakeClient(
      {
        resolveUiMessages: async (sessionId: string, messageIds: string[]) => {
          requests.push({ sessionId, messageIds });
          return {
            items: messageIds.map((messageId) => ({
              kind: 'message' as const,
              id: messageId,
              role: 'assistant' as const,
              parts: [{ type: 'text' as const, text: `target ${messageId}` }],
              replyable: true,
              status: 'done' as const,
              seq: '2026-07-21T00:00:00.000Z'
            }))
          };
        }
      },
      calls
    )
  });
  const input = {
    sessionId: 'ses_100000000000' as never,
    messageIds: ['msg_200000000000', 'msg_300000000000'] as never
  };

  const first = await store.dispatch(resolveUiMessagesApi.endpoints.resolveUiMessages.initiate(input));
  const second = await store.dispatch(resolveUiMessagesApi.endpoints.resolveUiMessages.initiate(input));

  expect(first.data?.items.map((item) => item.id)).toEqual(input.messageIds);
  expect(second.data?.items.map((item) => item.id)).toEqual(input.messageIds);
  expect(calls.resolveUiMessages).toBe(1);
  expect(requests).toEqual([{ sessionId: input.sessionId, messageIds: input.messageIds }]);
});

test('listAtomPacks caches by the Atoms tag', async () => {
  const calls: Calls = { usageGet: 0, atomsList: 0, workplaceExperiencesList: 0, resolveUiMessages: 0 };
  const store = createMonadStore({ client: fakeClient({}, calls) });

  await store.dispatch(atomsApi.endpoints.listAtomPacks.initiate());
  await store.dispatch(atomsApi.endpoints.listAtomPacks.initiate());
  expect(calls.atomsList).toBe(1);
});

test('listWorkplaceExperiences caches by the Atoms tag', async () => {
  const calls: Calls = { usageGet: 0, atomsList: 0, workplaceExperiencesList: 0, resolveUiMessages: 0 };
  const store = createMonadStore({ client: fakeClient({}, calls) });

  const first = await store.dispatch(atomsApi.endpoints.listWorkplaceExperiences.initiate());
  await store.dispatch(atomsApi.endpoints.listWorkplaceExperiences.initiate());

  expect(first.data?.experiences[0]?.id).toBe('canvas');
  expect(calls.workplaceExperiencesList).toBe(1);
});

test('a committed install invalidates Atoms; a consent-needed install does not', async () => {
  const calls: Calls = { usageGet: 0, atomsList: 0, workplaceExperiencesList: 0, resolveUiMessages: 0 };
  const store = createMonadStore({ client: fakeClient({}, calls) });

  await store.dispatch(atomsApi.endpoints.listAtomPacks.initiate());
  expect(calls.atomsList).toBe(1);

  // Default-deny: needsConsent → installed set unchanged → no refetch.
  const first = await store.dispatch(
    atomsApi.endpoints.installAtomPack.initiate({ source: 'local:/x', consent: false })
  );
  expect('data' in first && first.data?.needsConsent).toBe(true);
  await new Promise((r) => setTimeout(r, 0));
  expect(calls.atomsList).toBe(1);

  // With consent the pack lands → Atoms invalidated → the subscribed list refetches.
  await store.dispatch(atomsApi.endpoints.installAtomPack.initiate({ source: 'local:/x', consent: true }));
  await new Promise((r) => setTimeout(r, 0));
  expect(calls.atomsList).toBe(2);
});

test('setEnabled, remove, and discover each invalidate Atoms', async () => {
  for (const dispatchMutation of [
    (store: ReturnType<typeof createMonadStore>) =>
      store.dispatch(atomsApi.endpoints.setAtomPackEnabled.initiate({ name: 'pack', enabled: false })),
    (store: ReturnType<typeof createMonadStore>) => store.dispatch(atomsApi.endpoints.removeAtomPack.initiate('pack')),
    (store: ReturnType<typeof createMonadStore>) => store.dispatch(atomsApi.endpoints.discoverAtomKinds.initiate())
  ]) {
    const calls: Calls = { usageGet: 0, atomsList: 0, workplaceExperiencesList: 0, resolveUiMessages: 0 };
    const store = createMonadStore({ client: fakeClient({}, calls) });
    await store.dispatch(atomsApi.endpoints.listAtomPacks.initiate());
    expect(calls.atomsList).toBe(1);
    await dispatchMutation(store);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.atomsList).toBe(2);
  }
});

test('updateAtomPack delegates the installed name and invalidates the Atom Pack list', async () => {
  const updated: string[] = [];
  const calls: Calls = { usageGet: 0, atomsList: 0, workplaceExperiencesList: 0, resolveUiMessages: 0 };
  const store = createMonadStore({
    client: fakeClient(
      {
        updateAtomPack: async (name: string) => {
          updated.push(name);
        }
      },
      calls
    )
  });
  await store.dispatch(atomsApi.endpoints.listAtomPacks.initiate());

  const result = await store.dispatch(atomsApi.endpoints.updateAtomPack.initiate({ name: 'wa', revision: 'new' }));
  await Bun.sleep(0);

  expect({ updated, result: 'data' in result ? result.data : undefined, listCalls: calls.atomsList }).toEqual({
    updated: ['wa'],
    result: { name: 'wa', atoms: ['channel'], warnings: [] },
    listCalls: 2
  });
});

test('checkAtomPackUpdate returns the source comparison without invalidating the installed list', async () => {
  const checked: string[] = [];
  const calls: Calls = { usageGet: 0, atomsList: 0, workplaceExperiencesList: 0, resolveUiMessages: 0 };
  const store = createMonadStore({
    client: fakeClient(
      {
        checkAtomPackUpdate: async (name: string) => {
          checked.push(name);
        }
      },
      calls
    )
  });
  await store.dispatch(atomsApi.endpoints.listAtomPacks.initiate());

  const result = await store.dispatch(atomsApi.endpoints.checkAtomPackUpdate.initiate('wa'));

  expect({ checked, data: result.data, listCalls: calls.atomsList }).toEqual({
    checked: ['wa'],
    data: expect.objectContaining({ name: 'wa', sourceKind: 'local', hasUpdate: true }),
    listCalls: 1
  });
});

test('listAtomKinds returns the registered kinds', async () => {
  const calls: Calls = { usageGet: 0, atomsList: 0, workplaceExperiencesList: 0, resolveUiMessages: 0 };
  const store = createMonadStore({ client: fakeClient({}, calls) });

  const res = await store.dispatch(atomsApi.endpoints.listAtomKinds.initiate());
  expect(res.data?.kinds).toEqual(['tool', 'provider']);
});
