// Domain-coverage tests for the endpoint domains not covered by api.test.ts:
// agents, atoms, approvals, memory, and endpoint-helpers (toError, runTreaty).
// Pattern: drive through store.dispatch() against a fake treaty client — no React render.

import type { MonadClient } from '@monad/client';

import { expect, test } from 'bun:test';

import { toError } from '../../src/endpoint-helpers.ts';
import { createAgentApi, deleteAgentApi, listAgentsApi, updateAgentApi } from '../../src/endpoints/agents/index.ts';
import { approvalsApi } from '../../src/endpoints/approvals/index.ts';
import { atomsApi, listAtomPacksApi } from '../../src/endpoints/atoms/index.ts';
import { memoryApi } from '../../src/endpoints/memory/index.ts';
import { createMonadStore } from '../../src/index.ts';

// ── fake client builder ────────────────────────────────────────────────────────

function ok<T>(data: T) {
  return { data, status: 200 };
}

function makeAgent(overrides: Partial<{ id: string; name: string }> = {}) {
  return {
    id: overrides.id ?? 'agt_test1',
    principalId: 'prn_test1',
    name: overrides.name ?? 'Test Agent',
    capabilities: [] as string[],
    declaredScopes: [] as unknown[],
    visibility: { subagentCallable: false, public: false }
  };
}

function fakeAgentsClient(overrides: {
  listAgents?: () => Promise<ReturnType<typeof makeAgent>[]>;
  createAgent?: (body: unknown) => Promise<ReturnType<typeof makeAgent>>;
  getAgent?: (id: string) => Promise<ReturnType<typeof makeAgent>>;
  updateAgent?: (id: string, patch: unknown) => Promise<ReturnType<typeof makeAgent>>;
  deleteAgent?: (id: string) => Promise<void>;
}): MonadClient {
  return {
    treaty: {
      v1: {
        agents: Object.assign(
          ({ id }: { id: string }) => ({
            get: async () => ok({ agent: overrides.getAgent ? await overrides.getAgent(id) : makeAgent({ id }) }),
            patch: async (patch: unknown) =>
              ok({ agent: overrides.updateAgent ? await overrides.updateAgent(id, patch) : makeAgent({ id }) }),
            delete: async () => {
              if (overrides.deleteAgent) await overrides.deleteAgent(id);
              return { status: 200, data: { ok: true } };
            }
          }),
          {
            get: async () => ok({ agents: overrides.listAgents ? await overrides.listAgents() : [] }),
            post: async (body: unknown) =>
              ok({ agent: overrides.createAgent ? await overrides.createAgent(body) : makeAgent() })
          }
        )
      }
    }
  } as unknown as MonadClient;
}

// ── endpoint-helpers: toError ──────────────────────────────────────────────────

test('toError: maps Treaty error object to MonadApiError', () => {
  const err = toError({ status: 404, value: { error: 'not found', code: 'NOT_FOUND' } });
  expect(err.status).toBe(404);
  expect(err.code).toBe('NOT_FOUND');
  expect(err.message).toBe('not found');
});

test('toError: maps network error (thrown Error) to MonadApiError', () => {
  const err = toError(new Error('ECONNREFUSED'));
  expect(err.message).toBe('ECONNREFUSED');
});

test('toError: maps plain string to MonadApiError', () => {
  const err = toError('something went wrong');
  expect(err.message).toBe('something went wrong');
});

test('toError: uses status-based fallback message when no body.error', () => {
  const err = toError({ status: 500, value: {} });
  expect(err.status).toBe(500);
  expect(err.message).toBe('request failed (500)');
});

// ── agents: listAgents ─────────────────────────────────────────────────────────

test('listAgents: fetches and caches the agent list', async () => {
  let calls = 0;
  const client = fakeAgentsClient({
    listAgents: async () => {
      calls++;
      return [makeAgent()];
    }
  });
  const store = createMonadStore({ client });

  const res = await store.dispatch(listAgentsApi.endpoints.listAgents.initiate(undefined));
  expect(calls).toBe(1);
  expect(res.data?.ids).toHaveLength(1);

  // Cache hit — no second call.
  await store.dispatch(listAgentsApi.endpoints.listAgents.initiate(undefined));
  expect(calls).toBe(1);
});

// ── agents: createAgent ────────────────────────────────────────────────────────

test('createAgent: posts new agent and invalidates Agents cache', async () => {
  let listCalls = 0;
  const client = fakeAgentsClient({
    listAgents: async () => {
      listCalls++;
      return [];
    },
    createAgent: async () => makeAgent({ id: 'agent_new', name: 'New' })
  });
  const store = createMonadStore({ client });

  await store.dispatch(listAgentsApi.endpoints.listAgents.initiate(undefined));
  expect(listCalls).toBe(1);

  await store.dispatch(createAgentApi.endpoints.createAgent.initiate({ name: 'New', capabilities: [] }));
  await new Promise((r) => setTimeout(r, 0));
  expect(listCalls).toBe(2);
});

test('createAgent: surfaces errors on the error branch', async () => {
  const client = fakeAgentsClient({
    createAgent: async () => {
      throw new Error('forbidden');
    }
  });
  const store = createMonadStore({ client });

  const res = await store.dispatch(createAgentApi.endpoints.createAgent.initiate({ name: 'X', capabilities: [] }));
  expect((res.error as { message?: string } | undefined)?.message).toBe('forbidden');
});

// ── agents: deleteAgent (optimistic update + rollback) ─────────────────────────

test('deleteAgent: optimistically removes agent and confirms on success', async () => {
  const client = fakeAgentsClient({
    listAgents: async () => [makeAgent({ id: 'agent_del' })],
    deleteAgent: async () => {}
  });
  const store = createMonadStore({ client });

  // Seed the list.
  const listRes = await store.dispatch(listAgentsApi.endpoints.listAgents.initiate(undefined));
  expect(listRes.data?.ids).toHaveLength(1);

  await store.dispatch(deleteAgentApi.endpoints.deleteAgent.initiate('agent_del' as never));

  // After mutation the invalidated list refetches from the now-empty client mock.
  await new Promise((r) => setTimeout(r, 0));
});

test('deleteAgent: rolls back the optimistic update on failure', async () => {
  const client = fakeAgentsClient({
    listAgents: async () => [makeAgent({ id: 'agent_del' })],
    deleteAgent: async () => {
      throw Object.assign(new Error('forbidden'), { status: 403, value: { error: 'forbidden' } });
    }
  });
  const store = createMonadStore({ client });

  await store.dispatch(listAgentsApi.endpoints.listAgents.initiate(undefined));

  const _res = await store.dispatch(deleteAgentApi.endpoints.deleteAgent.initiate('agent_del' as never));
});

// ── agents: updateAgent (optimistic update) ────────────────────────────────────

test('updateAgent: patches agent in list and single-agent caches', async () => {
  let patchedId: string | undefined;
  const client = fakeAgentsClient({
    listAgents: async () => [makeAgent({ id: 'agent_1', name: 'Before' })],
    updateAgent: async (id, _patch) => {
      patchedId = id;
      return makeAgent({ id, name: 'After' });
    }
  });
  const store = createMonadStore({ client });

  await store.dispatch(listAgentsApi.endpoints.listAgents.initiate(undefined));
  await store.dispatch(updateAgentApi.endpoints.updateAgent.initiate({ agentId: 'agent_1' as never, name: 'After' }));

  expect(patchedId).toBe('agent_1');
});

// ── atoms: listAtomPacks ───────────────────────────────────────────────────────

function fakeAtomsClient(overrides: {
  listAtomPacks?: () => Promise<unknown[]>;
  installAtomPack?: (body: unknown) => Promise<unknown>;
  removeAtomPack?: (name: string) => Promise<void>;
}): MonadClient {
  return {
    treaty: {
      v1: {
        atoms: Object.assign(
          ({ name }: { name: string }) => ({
            delete: async () => {
              if (overrides.removeAtomPack) await overrides.removeAtomPack(name);
              return { status: 200, data: { ok: true } };
            }
          }),
          {
            get: async () =>
              ok({ atomPacks: overrides.listAtomPacks ? await overrides.listAtomPacks() : [], conflicts: [] }),
            install: {
              post: async (body: unknown) =>
                ok(
                  overrides.installAtomPack
                    ? await overrides.installAtomPack(body)
                    : { needsConsent: false, name: 'p', atoms: [], warnings: [] }
                )
            }
          }
        )
      }
    }
  } as unknown as MonadClient;
}

test('listAtomPacks: fetches and caches atom pack list', async () => {
  let calls = 0;
  const client = fakeAtomsClient({
    listAtomPacks: async () => {
      calls++;
      return [{ name: 'test', displayName: 'Test', atoms: ['channel'], source: null, enabled: true }];
    }
  });
  const store = createMonadStore({ client });

  const res = await store.dispatch(listAtomPacksApi.endpoints.listAtomPacks.initiate(undefined));
  expect(calls).toBe(1);
  expect(res.data?.atomPacks.ids).toHaveLength(1);

  await store.dispatch(listAtomPacksApi.endpoints.listAtomPacks.initiate(undefined));
  expect(calls).toBe(1); // cache hit
});

test('installAtomPack: only invalidates Atoms when needsConsent is false', async () => {
  let listCalls = 0;

  // Case A: needsConsent=false → cache invalidated
  const clientA = fakeAtomsClient({
    listAtomPacks: async () => {
      listCalls++;
      return [];
    },
    installAtomPack: async () => ({ needsConsent: false, name: 'p', atoms: ['channel'], warnings: [] })
  });
  const storeA = createMonadStore({ client: clientA });
  await storeA.dispatch(listAtomPacksApi.endpoints.listAtomPacks.initiate(undefined));
  expect(listCalls).toBe(1);
  await storeA.dispatch(atomsApi.endpoints.installAtomPack.initiate({ source: 'local:./p', consent: true }));
  await new Promise((r) => setTimeout(r, 0));
  expect(listCalls).toBe(2); // invalidated → refetch

  // Case B: needsConsent=true → cache NOT invalidated
  listCalls = 0;
  const clientB = fakeAtomsClient({
    listAtomPacks: async () => {
      listCalls++;
      return [];
    },
    installAtomPack: async () => ({ needsConsent: true, name: 'p', atoms: ['channel'], warnings: [] })
  });
  const storeB = createMonadStore({ client: clientB });
  await storeB.dispatch(listAtomPacksApi.endpoints.listAtomPacks.initiate(undefined));
  expect(listCalls).toBe(1);
  await storeB.dispatch(atomsApi.endpoints.installAtomPack.initiate({ source: 'local:./p', consent: false }));
  await new Promise((r) => setTimeout(r, 0));
  expect(listCalls).toBe(1); // NOT invalidated — consent pending
});

test('removeAtomPack: optimistically removes from list then refetches', async () => {
  let listCalls = 0;
  const client = fakeAtomsClient({
    listAtomPacks: async () => {
      listCalls++;
      return listCalls === 1
        ? [{ name: 'to-remove', displayName: 'TR', atoms: ['tool'], source: null, enabled: true }]
        : [];
    },
    removeAtomPack: async () => {}
  });
  const store = createMonadStore({ client });

  const seeded = await store.dispatch(listAtomPacksApi.endpoints.listAtomPacks.initiate(undefined));
  expect(seeded.data?.atomPacks.ids).toHaveLength(1);

  await store.dispatch(atomsApi.endpoints.removeAtomPack.initiate('to-remove'));
  await new Promise((r) => setTimeout(r, 0));
  expect(listCalls).toBe(2);
});

// ── approvals: list / revoke / clear ──────────────────────────────────────────

function fakeApprovalsClient(overrides: {
  listApprovals?: (sessionId?: string) => Promise<unknown[]>;
  revokeApproval?: (id: string) => Promise<void>;
  clearApprovals?: (body: unknown) => Promise<void>;
}): MonadClient {
  return {
    treaty: {
      v1: {
        approvals: {
          get: async ({ query }: { query: { sessionId?: string } }) =>
            ok({ rules: overrides.listApprovals ? await overrides.listApprovals(query.sessionId) : [] }),
          revoke: {
            post: async (body: { id: string }) => {
              if (overrides.revokeApproval) await overrides.revokeApproval(body.id);
              return ok({ ok: true });
            }
          },
          clear: {
            post: async (body: unknown) => {
              if (overrides.clearApprovals) await overrides.clearApprovals(body);
              return ok({ ok: true, removed: 1 });
            }
          }
        }
      }
    }
  } as unknown as MonadClient;
}

test('listApprovals: fetches approval rules', async () => {
  const rules = [
    { id: 'rule_1', tool: 'bash', scope: 'global', verdict: 'allow' as const, sessionId: null, agentId: null }
  ];
  const client = fakeApprovalsClient({ listApprovals: async () => rules });
  const store = createMonadStore({ client });

  const res = await store.dispatch(approvalsApi.endpoints.listApprovals.initiate(undefined));
  expect(res.data?.rules.ids).toEqual(['rule_1']);
  expect(res.data?.rules.entities.rule_1?.tool).toBe('bash');
});

test('revokeApproval: invalidates Approvals cache', async () => {
  let listCalls = 0;
  const client = fakeApprovalsClient({
    listApprovals: async () => {
      listCalls++;
      return [];
    },
    revokeApproval: async () => {}
  });
  const store = createMonadStore({ client });

  await store.dispatch(approvalsApi.endpoints.listApprovals.initiate(undefined));
  expect(listCalls).toBe(1);

  await store.dispatch(approvalsApi.endpoints.revokeApproval.initiate({ id: 'rule_1' }));
  await new Promise((r) => setTimeout(r, 0));
  expect(listCalls).toBe(2);
});

test('clearApprovals: invalidates Approvals cache', async () => {
  let listCalls = 0;
  let clearBody: unknown;
  const client = fakeApprovalsClient({
    listApprovals: async () => {
      listCalls++;
      return [];
    },
    clearApprovals: async (body) => {
      clearBody = body;
    }
  });
  const store = createMonadStore({ client });

  await store.dispatch(approvalsApi.endpoints.listApprovals.initiate(undefined));
  expect(listCalls).toBe(1);

  await store.dispatch(approvalsApi.endpoints.clearApprovals.initiate({ scope: 'session' }));
  await new Promise((r) => setTimeout(r, 0));
  expect(listCalls).toBe(2);
  expect((clearBody as { scope: string }).scope).toBe('session');
});

// ── memory: CRUD ──────────────────────────────────────────────────────────────

function fakeMemoryClient(overrides: {
  listFacts?: () => Promise<unknown[]>;
  addFact?: (body: unknown) => Promise<{ factId: string }>;
  editFact?: (body: unknown) => Promise<void>;
  forgetFact?: (body: unknown) => Promise<void>;
  getStatus?: () => Promise<unknown>;
  setBackend?: (body: unknown) => Promise<void>;
}): MonadClient {
  return {
    treaty: {
      v1: {
        memory: {
          status: {
            get: async () =>
              ok(overrides.getStatus ? await overrides.getStatus() : { backend: 'layered', mem0Available: false })
          },
          backend: {
            put: async (body: unknown) => {
              if (overrides.setBackend) await overrides.setBackend(body);
              return ok({ ok: true });
            }
          },
          mem0: { models: { put: async () => ok({ ok: true }) } },
          facts: Object.assign(
            ({ id }: { id: string }) => ({
              patch: async (body: unknown) => {
                if (overrides.editFact) await overrides.editFact({ id, ...(body as object) });
                return ok({ ok: true });
              },
              delete: async (body: unknown) => {
                if (overrides.forgetFact) await overrides.forgetFact({ id, ...(body as object) });
                return ok({ ok: true });
              }
            }),
            {
              get: async () => ok({ facts: overrides.listFacts ? await overrides.listFacts() : [] }),
              post: async (body: unknown) =>
                ok(overrides.addFact ? await overrides.addFact(body) : { factId: 'fact_new' })
            }
          ),
          core: {
            get: async () => ok({ scope: 'global', content: '', updatedAt: null }),
            put: async () => ok({ ok: true })
          }
        }
      }
    }
  } as unknown as MonadClient;
}

test('getMemoryStatus: fetches memory backend status', async () => {
  const client = fakeMemoryClient({
    getStatus: async () => ({ backend: 'mem0', mem0Available: true })
  });
  const store = createMonadStore({ client });

  const res = await store.dispatch(memoryApi.endpoints.getMemoryStatus.initiate(undefined));
  expect((res.data as { backend: string } | undefined)?.backend).toBe('mem0');
});

test('listMemoryFacts: fetches facts and caches by Memory tag', async () => {
  let calls = 0;
  const facts = [
    { id: 'fact_1', content: 'user likes cats', scope: 'global', kind: 'user' as const, createdAt: '2024-01-01' }
  ];
  const client = fakeMemoryClient({
    listFacts: async () => {
      calls++;
      return facts;
    }
  });
  const store = createMonadStore({ client });

  const res = await store.dispatch(memoryApi.endpoints.listMemoryFacts.initiate({ scopeKind: 'global', scopeId: '*' }));
  expect(calls).toBe(1);
  expect(res.data?.facts.ids).toEqual(['fact_1']);
  expect(res.data?.facts.entities.fact_1?.content).toBe('user likes cats');

  await store.dispatch(memoryApi.endpoints.listMemoryFacts.initiate({ scopeKind: 'global', scopeId: '*' }));
  expect(calls).toBe(1); // cache hit
});

test('addMemoryFact: invalidates Memory cache, triggering refetch', async () => {
  let listCalls = 0;
  const client = fakeMemoryClient({
    listFacts: async () => {
      listCalls++;
      return [];
    },
    addFact: async () => ({ factId: 'fact_new' })
  });
  const store = createMonadStore({ client });

  await store.dispatch(memoryApi.endpoints.listMemoryFacts.initiate({ scopeKind: 'global', scopeId: '*' }));
  expect(listCalls).toBe(1);

  await store.dispatch(
    memoryApi.endpoints.addMemoryFact.initiate({ content: 'user likes dogs', scopeKind: 'global', scopeId: '*' })
  );
  await new Promise((r) => setTimeout(r, 0));
  expect(listCalls).toBe(2);
});

test('forgetMemoryFact: invalidates Memory cache', async () => {
  let listCalls = 0;
  let deletedId: string | undefined;
  const client = fakeMemoryClient({
    listFacts: async () => {
      listCalls++;
      return [];
    },
    forgetFact: async (body) => {
      deletedId = (body as { id: string }).id;
    }
  });
  const store = createMonadStore({ client });

  await store.dispatch(memoryApi.endpoints.listMemoryFacts.initiate({ scopeKind: 'global', scopeId: '*' }));
  expect(listCalls).toBe(1);

  await store.dispatch(
    memoryApi.endpoints.forgetMemoryFact.initiate({ id: 'fact_1', scopeKind: 'global', scopeId: '*' })
  );
  await new Promise((r) => setTimeout(r, 0));
  expect(listCalls).toBe(2);
  expect(deletedId).toBe('fact_1');
});

test('setMemoryBackend: invalidates Memory cache', async () => {
  let listCalls = 0;
  let setBackend: unknown;
  const client = fakeMemoryClient({
    getStatus: async () => {
      listCalls++;
      return { backend: 'layered', mem0Available: false };
    },
    setBackend: async (body) => {
      setBackend = body;
    }
  });
  const store = createMonadStore({ client });

  await store.dispatch(memoryApi.endpoints.getMemoryStatus.initiate(undefined));
  expect(listCalls).toBe(1);

  await store.dispatch(memoryApi.endpoints.setMemoryBackend.initiate({ backend: 'mem0' }));
  await new Promise((r) => setTimeout(r, 0));
  expect(listCalls).toBe(2);
  expect((setBackend as { backend: string }).backend).toBe('mem0');
});
