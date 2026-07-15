// Offline wiring tests for the feature endpoints added for web-UI parity (usage reset, clarify,
// session branch/restore/provenance, atom-pack management). Same approach as api.test.ts: drive
// endpoints through store.dispatch against a fake treaty-backed client, asserting delegation,
// response shaping, and tag-based invalidation — no React render, no live daemon.

import type { MonadClient } from '@monad/client';

import { expect, test } from 'bun:test';

import { atomsApi } from '../../src/endpoints/atoms/index.ts';
import { branchSessionApi, provenanceApi, restoreSessionApi } from '../../src/endpoints/sessions/index.ts';
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
  workspaceExperiencesList: number;
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
              return ok({ ok: true });
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
          provenance: {
            get: async () => {
              const self = { id, title: 't', createdAt: '', updatedAt: '' };
              return ok({ ancestors: [{ id: 'ses_parent000000', title: 'p' }], self, descendants: [] });
            }
          },
          restore: {
            post: async (body: { toMessageId: string }) => {
              const fn = overrides.restore as ((sessionId: string, toMessageId: string) => Promise<void>) | undefined;
              if (fn) await fn(id, body.toMessageId);
              return ok({ restoredCount: 1, newHeadMessageId: body.toMessageId });
            }
          }
        }),
        atoms: Object.assign(
          ({ name }: { name: string }) => ({
            enable: { post: async () => ok({ ok: true }) },
            disable: { post: async () => ok({ ok: true }) },
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
            'workspace-experiences': {
              get: async () => {
                calls.workspaceExperiencesList++;
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
  const calls: Calls = { usageGet: 0, atomsList: 0, workspaceExperiencesList: 0 };
  const store = createMonadStore({ client: fakeClient({}, calls) });

  await store.dispatch(getUsageApi.endpoints.getUsage.initiate(undefined));
  expect(calls.usageGet).toBe(1);

  await store.dispatch(resetUsageApi.endpoints.resetUsage.initiate());
  await new Promise((r) => setTimeout(r, 0));
  expect(calls.usageGet).toBe(2);
});

test('clarifyRespond delegates the answer and returns ok', async () => {
  let seen: { requestId: string; answer: string } | undefined;
  const calls: Calls = { usageGet: 0, atomsList: 0, workspaceExperiencesList: 0 };
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
  expect('data' in res && res.data?.ok).toBe(true);
  expect(seen).toEqual({ requestId: 'clarify_1', answer: 'yes' });
});

test('branchSession returns the child id and passes the message checkpoint', async () => {
  let branchedAt: string | undefined;
  const calls: Calls = { usageGet: 0, atomsList: 0, workspaceExperiencesList: 0 };
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
  const calls: Calls = { usageGet: 0, atomsList: 0, workspaceExperiencesList: 0 };
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

test('provenance returns ancestors and descendants for the session', async () => {
  const calls: Calls = { usageGet: 0, atomsList: 0, workspaceExperiencesList: 0 };
  const store = createMonadStore({ client: fakeClient({}, calls) });

  const res = await store.dispatch(provenanceApi.endpoints.provenance.initiate('ses_100000000000' as never));
  expect(res.data?.ancestors[0]?.id).toBe('ses_parent000000');
  expect(res.data?.self.id).toBe('ses_100000000000');
});

test('listAtomPacks caches by the Atoms tag', async () => {
  const calls: Calls = { usageGet: 0, atomsList: 0, workspaceExperiencesList: 0 };
  const store = createMonadStore({ client: fakeClient({}, calls) });

  await store.dispatch(atomsApi.endpoints.listAtomPacks.initiate());
  await store.dispatch(atomsApi.endpoints.listAtomPacks.initiate());
  expect(calls.atomsList).toBe(1);
});

test('listWorkspaceExperiences caches by the Atoms tag', async () => {
  const calls: Calls = { usageGet: 0, atomsList: 0, workspaceExperiencesList: 0 };
  const store = createMonadStore({ client: fakeClient({}, calls) });

  const first = await store.dispatch(atomsApi.endpoints.listWorkspaceExperiences.initiate());
  await store.dispatch(atomsApi.endpoints.listWorkspaceExperiences.initiate());

  expect(first.data?.experiences[0]?.id).toBe('canvas');
  expect(calls.workspaceExperiencesList).toBe(1);
});

test('a committed install invalidates Atoms; a consent-needed install does not', async () => {
  const calls: Calls = { usageGet: 0, atomsList: 0, workspaceExperiencesList: 0 };
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
    const calls: Calls = { usageGet: 0, atomsList: 0, workspaceExperiencesList: 0 };
    const store = createMonadStore({ client: fakeClient({}, calls) });
    await store.dispatch(atomsApi.endpoints.listAtomPacks.initiate());
    expect(calls.atomsList).toBe(1);
    await dispatchMutation(store);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.atomsList).toBe(2);
  }
});

test('listAtomKinds returns the registered kinds', async () => {
  const calls: Calls = { usageGet: 0, atomsList: 0, workspaceExperiencesList: 0 };
  const store = createMonadStore({ client: fakeClient({}, calls) });

  const res = await store.dispatch(atomsApi.endpoints.listAtomKinds.initiate());
  expect(res.data?.kinds).toEqual(['tool', 'provider']);
});
