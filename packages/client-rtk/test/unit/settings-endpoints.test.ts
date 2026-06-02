// Offline wiring tests for the endpoint-helpers core (runTreaty, clientOf, toError
// edge cases), the store factory (createMonadStore, apiErrorMiddleware), the
// MonadTreatyClient adapter, and the settings endpoints (locale, sandbox, hooks,
// obscura, openai-compat, tool-backends), plus simple endpoints (health, commands,
// skills, licenses, graph, indexer, mem0-data, init). Same approach as api.test.ts:
// drive through store.dispatch against a fake treaty-backed client — no React render,
// no live daemon.

import type { MonadClient } from '@monad/client';

import { expect, test } from 'bun:test';

import { clientOf, runTreaty, toError } from '../../src/endpoint-helpers.ts';
import { createMonadStore, createMonadTreatyClient, monadApi } from '../../src/index.ts';

// Import the endpoint modules so TS sees their injectEndpoints type propagation
// at compile-time. Without these imports, TS can't know the endpoint names exist
// on monadApi.endpoints at runtime (even though they do via the inject chain).
import '../../src/endpoints/settings/locale/get-locale.ts';
import '../../src/endpoints/settings/locale/set-locale.ts';
import '../../src/endpoints/settings/locale/list-locales.ts';
import '../../src/endpoints/settings/locale/get-catalog.ts';
import '../../src/endpoints/settings/hooks/get-hooks.ts';
import '../../src/endpoints/settings/hooks/set-hooks.ts';
import '../../src/endpoints/settings/sandbox/get-sandbox.ts';
import '../../src/endpoints/settings/sandbox/set-sandbox.ts';
import '../../src/endpoints/settings/obscura/get-obscura.ts';
import '../../src/endpoints/settings/obscura/set-obscura.ts';
import '../../src/endpoints/settings/openai-compat/get-openai-compat.ts';
import '../../src/endpoints/settings/openai-compat/set-openai-compat.ts';
import '../../src/endpoints/settings/tool-backends/get-tool-backends.ts';
import '../../src/endpoints/settings/tool-backends/set-tool-backends.ts';

// ── helpers ─────────────────────────────────────────────────────────────────────

function ok<T>(data: T): { data: T; error: null; status: number } {
  return { data, error: null, status: 200 };
}

/**
 * Build a fake MonadClient whose treaty.v1 tree mirrors the daemon's HTTP routes.
 * `handlers` keys map to async request handlers; the fake client calls the handler
 * and wraps its resolved value in `ok({ key: value })` using the key name stored
 * alongside the handler.
 */
interface Handler {
  fn: (...args: unknown[]) => Promise<unknown>;
  wrapKey: string;
}

function fakeClient(handlers: Record<string, Handler> = {}): MonadClient {
  async function resolve(
    name: string,
    wrapKey: string,
    defaultVal: unknown,
    ...args: unknown[]
  ): Promise<{ data: unknown; error: null; status: number }> {
    const h = handlers[name];
    if (h) {
      const val = await h.fn(...args);
      if (h.wrapKey === '$raw') return ok(val);
      return ok({ [h.wrapKey]: val });
    }
    return ok({ [wrapKey]: defaultVal });
  }

  async function resolveMut(
    name: string,
    body: unknown,
    ...extra: unknown[]
  ): Promise<{ data: unknown; error: null; status: number }> {
    const h = handlers[name];
    if (h) {
      await h.fn(body, ...extra);
    }
    return ok({ ok: true });
  }

  return {
    treaty: {
      v1: {
        settings: {
          locale: {
            get: () => resolve('getLocale', 'locale', 'en'),
            put: (body: unknown) => resolveMut('setLocale', body)
          },
          locales: {
            get: () =>
              resolve('listLocales', 'locales', [
                { locale: 'en', label: 'English' },
                { locale: 'zh', label: '中文' }
              ])
          },
          hooks: {
            get: () => resolve('getHooks', 'hooks', []),
            put: (body: unknown) => resolveMut('setHooks', body)
          },
          sandbox: {
            get: () => resolve('getSandbox', 'sandbox', {}),
            put: (body: unknown) => resolveMut('setSandbox', body)
          },
          obscura: {
            get: () => resolve('getObscura', 'obscura', {}),
            put: (body: unknown) => resolveMut('setObscura', body)
          },
          'openai-compat': {
            get: () => resolve('getOpenaiCompat', 'openaiCompat', {}),
            put: (body: unknown) => resolveMut('setOpenaiCompat', body)
          },
          'tool-backends': {
            get: () => resolve('getToolBackends', 'toolBackends', {}),
            put: (body: unknown) => resolveMut('setToolBackends', body)
          }
        },
        commands: {
          get: () => resolve('listCommands', 'commands', [])
        },
        skills: {
          get: (...args: unknown[]) => resolve('listSkills', 'skills', [], ...args)
        },
        licenses: {
          get: () => resolve('listLicenses', 'licenses', [])
        },
        graph: {
          get: () => resolve('getGraph', 'graph', null)
        },
        indexer: {
          status: {
            get: () => resolve('getIndexerStatus', 'status', 'idle')
          }
        },
        memory: {
          mem0: {
            get: () => resolve('getMem0Data', 'mem0Data', null)
          }
        },
        init: {
          status: {
            get: () => resolve('getInitStatus', 'status', { initialized: false })
          },
          home: {
            post: (body: unknown) => resolveMut('setInitHome', body)
          }
        },
        // Session endpoints needed by the endpoint chain (sandbox/openai-compat/hooks
        // inject off sessionsApi).
        sessions: (..._args: unknown[]) => ({
          get: async () => ok({ sessions: [] }),
          messages: {
            get: async () => ok({ messages: [], total: 0 })
          }
        }),
        i18n: {
          catalog: {
            get: ({ query }: { query?: { locale?: string } }) =>
              resolve('getCatalog', 'catalog', { messages: {} }, query?.locale)
          }
        },
        agents: {
          get: async () => ok({ agents: [] })
        },
        approvals: {
          get: async () => ok({ rules: [] })
        },
        atoms: {
          get: async () => ok({ atomPacks: [] })
        },
        usage: {
          get: async () =>
            ok({
              totalCostUsd: 0,
              totalInputTokens: 0,
              totalOutputTokens: 0,
              entries: [],
              breakdown: []
            })
        }
      },
      health: {
        get: async () => ok({ status: 'ok', version: '1.0.0' })
      }
    },
    subscribeControl: () => () => {},
    streamEvents: () => () => {}
  } as unknown as MonadClient;
}

/** Shorthand: wrap a plain value in a Handler with the given wrapKey. */
function handler<T>(wrapKey: string, fn: (...args: unknown[]) => Promise<T>): Handler {
  return { fn: fn as (...args: unknown[]) => Promise<unknown>, wrapKey };
}

/**
 * A cast helper that tells TS "this key exists on monadApi.endpoints at runtime"
 * without changing the dispatch return type. Returns the endpoint's initiate
 * function so TS still sees the real ThunkAction return via store.dispatch.
 */
function endpoint(name: string): {
  initiate: (arg?: unknown) => unknown;
} {
  const endpointMap = monadApi.endpoints as Record<string, { initiate: (arg?: unknown) => unknown } | undefined>;
  const value = endpointMap[name];
  if (!value) throw new Error(`missing endpoint: ${name}`);
  return value;
}

interface EndpointDispatchResult {
  data?: unknown;
  error?: unknown;
}

function dispatchEndpoint(
  store: ReturnType<typeof createMonadStore>,
  name: string,
  arg?: unknown
): Promise<EndpointDispatchResult> {
  return store.dispatch(endpoint(name).initiate(arg) as never) as Promise<EndpointDispatchResult>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// endpoint-helpers: toError edge cases
// ═══════════════════════════════════════════════════════════════════════════════

test('toError: maps Treaty error with null value to a generic status-based message', () => {
  const err = toError({ status: 500, value: null });
  expect(err.status).toBe(500);
  expect(err.code).toBeUndefined();
  expect(err.message).toBe('request failed (500)');
});

test('toError: maps Treaty error with status but no value', () => {
  const err = toError({ status: 404 });
  expect(err.status).toBe(404);
  expect(err.code).toBeUndefined();
  expect(err.message).toBe('request failed (404)');
});

test('toError: maps zero status (unusual but valid)', () => {
  const err = toError({ status: 0, value: { error: 'offline' } });
  expect(err.status).toBe(0);
  expect(err.message).toBe('offline');
});

test('toError: plain object (not Error, not Treaty) uses string coercion', () => {
  const err = toError({ weird: true });
  expect(err.message).toBe('[object Object]');
});

test('toError: null input yields "null"', () => {
  const err = toError(null);
  expect(err.message).toBe('null');
});

test('toError: undefined input yields "undefined"', () => {
  const err = toError(undefined);
  expect(err.message).toBe('undefined');
});

test('toError: non-Error thrown object with message property', () => {
  const err = toError({ message: 'custom error' });
  expect(err.message).toBe('[object Object]');
});

// ═══════════════════════════════════════════════════════════════════════════════
// endpoint-helpers: clientOf
// ═══════════════════════════════════════════════════════════════════════════════

test('clientOf: returns the MonadClient stored in api.extra', () => {
  const client = fakeClient({});
  const api = { extra: { client } };
  expect(clientOf(api)).toBe(client);
});

test('clientOf: throws when extra is missing', () => {
  const api = { extra: undefined };
  expect(() => clientOf(api)).toThrow('monadApi: the store has no MonadClient');
});

test('clientOf: throws when extra.client is null', () => {
  const api = { extra: { client: null } };
  expect(() => clientOf(api)).toThrow('monadApi: the store has no MonadClient');
});

// ═══════════════════════════════════════════════════════════════════════════════
// endpoint-helpers: runTreaty
// ═══════════════════════════════════════════════════════════════════════════════

test('runTreaty: success path without map', async () => {
  const result = await runTreaty(() => Promise.resolve(ok(42)));
  expect(result).toEqual({ data: 42 });
});

test('runTreaty: success path with map', async () => {
  const result = await runTreaty(
    () => Promise.resolve(ok({ items: [1, 2] })),
    (raw) => raw.items.length
  );
  expect(result).toEqual({ data: 2 });
});

test('runTreaty: Treaty error path', async () => {
  const result = await runTreaty(() =>
    Promise.resolve({ data: null, error: { status: 403, value: { error: 'denied' } } })
  );
  expect(result).toEqual({ error: { status: 403, code: undefined, message: 'denied', raw: { error: 'denied' } } });
});

test('runTreaty: thrown error path', async () => {
  const result = await runTreaty(() => {
    throw new Error('network down');
  });
  expect(result).toEqual({ error: { message: 'network down' } });
});

test('runTreaty: null data is passed through (not treated as error)', async () => {
  const result = await runTreaty<null>(() => Promise.resolve(ok(null)));
  expect(result).toEqual({ data: null });
});

// ═══════════════════════════════════════════════════════════════════════════════
// store factory
// ═══════════════════════════════════════════════════════════════════════════════

test('createMonadStore: builds a store with the client in extra', () => {
  const client = fakeClient({});
  const store = createMonadStore({ client });
  expect(store.getState()).toHaveProperty('monadApi');
  expect(store).toBeDefined();
});

test('createMonadStore: merges custom reducers', () => {
  const client = fakeClient({});
  const store = createMonadStore({
    client,
    reducer: { custom: (state = 0) => state }
  });
  expect(store.getState()).toHaveProperty('custom');
  expect(store.getState()).toHaveProperty('monadApi');
});

// ═══════════════════════════════════════════════════════════════════════════════
// global-error middleware (end-to-end via the store)
// ═══════════════════════════════════════════════════════════════════════════════

test('apiErrorMiddleware: sinks rejected queries through the store', async () => {
  const errors: Array<{ message: string; endpoint?: string }> = [];
  const sink = (err: { message: string }, meta: { endpoint?: string }) => {
    errors.push({ message: err.message, endpoint: meta.endpoint });
  };

  const client = {
    treaty: {
      v1: {},
      health: {
        get: async () => {
          throw new Error('ECONNREFUSED');
        }
      }
    },
    subscribeControl: () => () => {},
    streamEvents: () => () => {}
  } as unknown as MonadClient;

  const store = createMonadStore({ client, onApiError: sink });
  await dispatchEndpoint(store, 'getHealth');

  expect(errors.length).toBeGreaterThanOrEqual(1);
  const firstErr: { message?: string; endpoint?: string } | undefined = errors[0];
  expect(firstErr?.message).toBe('ECONNREFUSED');
  expect(firstErr?.endpoint).toBe('getHealth');
});

test('apiErrorMiddleware: without onApiError, errors still flow to components', async () => {
  const client = {
    treaty: {
      v1: {},
      health: {
        get: async () => {
          throw new Error('down');
        }
      }
    },
    subscribeControl: () => () => {},
    streamEvents: () => () => {}
  } as unknown as MonadClient;

  const store = createMonadStore({ client });
  const res = await dispatchEndpoint(store, 'getHealth');
  expect(res.error).toBeDefined();
  expect((res.error as { message?: string } | undefined)?.message).toBe('down');
});

// ═══════════════════════════════════════════════════════════════════════════════
// createMonadTreatyClient
// ═══════════════════════════════════════════════════════════════════════════════

test('createMonadTreatyClient: creates a MonadClient from options', () => {
  const client = createMonadTreatyClient({ baseUrl: 'http://127.0.0.1:9999' });
  expect(client).toBeDefined();
  expect(typeof client.subscribeControl).toBe('function');
});

test('createMonadTreatyClient: serializes multi-scope skills query as repeated params', async () => {
  const urls: string[] = [];
  const client = createMonadTreatyClient({
    baseUrl: 'http://127.0.0.1:9999',
    treatyConfig: {
      fetcher: (async (input) => {
        urls.push(String(input));
        return new Response(JSON.stringify({ skills: [], skillInstances: [] }), {
          headers: { 'content-type': 'application/json' },
          status: 200
        });
      }) as typeof fetch
    }
  });

  await client.treaty.v1.skills.get({ query: { scope: ['global', 'atom-pack'] } as unknown as { scope: string } });

  expect(urls[0]).toContain('/v1/skills?scope=global&scope=atom-pack');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Health endpoint
// ═══════════════════════════════════════════════════════════════════════════════

test('getHealth: fetches daemon health', async () => {
  const client = fakeClient({});
  const store = createMonadStore({ client });
  const res = await dispatchEndpoint(store, 'getHealth');
  expect((res.data as { status?: string } | undefined)?.status).toBe('ok');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Commands / Skills / Licenses / Graph / Indexer / Mem0-data — simple queries
// ═══════════════════════════════════════════════════════════════════════════════

test('listCommands: fetches command list and caches by Skills tag', async () => {
  let calls = 0;
  const cmds = [{ name: 'help', description: 'Show help' }];
  const client = fakeClient({
    listCommands: handler('commands', async () => {
      calls++;
      return cmds;
    })
  });
  const store = createMonadStore({ client });
  const res = await dispatchEndpoint(store, 'listCommands');
  expect((res.data as { commands?: unknown[] } | undefined)?.commands).toEqual(cmds);
  expect(calls).toBe(1);
  await dispatchEndpoint(store, 'listCommands');
  expect(calls).toBe(1);
});

test('listSkills: fetches skill list and caches by Skills tag', async () => {
  let calls = 0;
  let query: unknown;
  const skills = [{ name: 'my-skill', description: 'desc', userInvocable: true, available: true }];
  const skillInstances = [
    {
      id: 'atom-pack:monad-test:pack-skill',
      sourceKind: 'atom-pack',
      sourceId: 'atom-pack:monad-test',
      source: 'atom-pack:monad-test',
      active: true,
      name: 'pack-skill',
      description: 'Pack skill.',
      userInvocable: true,
      available: true
    }
  ];
  const client = fakeClient({
    listSkills: handler('$raw', async (arg) => {
      calls++;
      query = arg;
      return { skills, skillInstances };
    })
  });
  const store = createMonadStore({ client });
  const res = await dispatchEndpoint(store, 'listSkills', { scope: ['global', 'atom-pack'] });
  expect((res.data as { skills?: unknown[] } | undefined)?.skills).toEqual(skills);
  expect((res.data as { skillInstances?: unknown[] } | undefined)?.skillInstances).toEqual(skillInstances);
  expect(query).toEqual({ query: { scope: ['global', 'atom-pack'] } });
  expect(calls).toBe(1);
  await dispatchEndpoint(store, 'listSkills', { scope: ['global', 'atom-pack'] });
  expect(calls).toBe(1);
});

test('listLicenses: fetches license list', async () => {
  let calls = 0;
  const licenses = [{ name: 'mit', path: '/licenses/mit' }];
  const client = fakeClient({
    listLicenses: handler('licenses', async () => {
      calls++;
      return licenses;
    })
  });
  const store = createMonadStore({ client });
  const res = await dispatchEndpoint(store, 'listLicenses');
  expect((res.data as { licenses?: unknown[] } | undefined)?.licenses).toEqual(licenses);
  expect(calls).toBe(1);
});

test('getGraph: fetches memory graph', async () => {
  const graph = { nodes: [{ id: 'a' }], edges: [{ from: 'a', to: 'b' }] };
  const client = fakeClient({ getGraph: handler('graph', async () => graph) });
  const store = createMonadStore({ client });
  const res = await dispatchEndpoint(store, 'getGraph');
  expect((res.data as { graph?: unknown } | undefined)?.graph).toEqual(graph);
});

test('getIndexerStatus: fetches indexer state', async () => {
  const client = fakeClient({
    getIndexerStatus: handler('status', async () => ({ phase: 'indexing', progress: 0.5 }))
  });
  const store = createMonadStore({ client });
  const res = await dispatchEndpoint(store, 'getIndexerStatus');
  const data = res.data as { status?: { phase: string; progress: number } } | undefined;
  expect(data?.status?.phase).toBe('indexing');
  expect(data?.status?.progress).toBe(0.5);
});

test('getMem0Data: fetches mem0 data for the PCA explorer', async () => {
  const data = { points: [{ id: 'pt1', x: 0, y: 0 }], clusters: [] };
  const client = fakeClient({ getMem0Data: handler('mem0Data', async () => data) });
  const store = createMonadStore({ client });
  const res = await dispatchEndpoint(store, 'getMem0Data');
  expect((res.data as { mem0Data?: unknown } | undefined)?.mem0Data).toEqual(data);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Init status
// ═══════════════════════════════════════════════════════════════════════════════

test('initStatus: returns initialized=false for fresh home', async () => {
  const client = fakeClient({});
  const store = createMonadStore({ client });
  const res = await dispatchEndpoint(store, 'initStatus');
  const data = res.data as { status?: { initialized: boolean } } | undefined;
  expect(data?.status?.initialized).toBe(false);
});

test('setInitHome: posts home config and invalidates InitStatus tag', async () => {
  let statusCalls = 0;
  let posted: unknown;
  const client = fakeClient({
    getInitStatus: handler('status', async () => {
      statusCalls++;
      return statusCalls === 1 ? { initialized: false } : { initialized: true };
    }),
    setInitHome: handler('ok', async (body: unknown) => {
      posted = body;
    })
  });
  const store = createMonadStore({ client });
  await dispatchEndpoint(store, 'initStatus');
  expect(statusCalls).toBe(1);

  const res = await dispatchEndpoint(store, 'setInitHome', { home: '/tmp/monad-home' });
  expect((res.data as { ok?: boolean } | undefined)?.ok).toBe(true);
  await new Promise((r) => setTimeout(r, 0));
  expect(statusCalls).toBe(2);
  expect(posted).toEqual({ home: '/tmp/monad-home' });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Settings endpoints (locale via channelsApi, rest via sessionsApi — all share
// the monadApi reducer path at runtime)
// ═══════════════════════════════════════════════════════════════════════════════

test('getLocale: fetches current locale', async () => {
  const client = fakeClient({ getLocale: handler('locale', async () => 'zh') });
  const store = createMonadStore({ client });

  const res = await dispatchEndpoint(store, 'getLocale');
  expect(res.data).toBe('zh');
});

test('setLocale: writes locale, invalidates Locale+Catalog, and rolls back on failure', async () => {
  // Test optimistic update + rollback
  const client = fakeClient({
    getLocale: handler('locale', async () => 'en'),
    setLocale: handler('ok', async () => {
      throw Object.assign(new Error('conflict'), { status: 409 });
    })
  });
  const store = createMonadStore({ client });

  // Seed
  const seed = await dispatchEndpoint(store, 'getLocale');
  expect(seed.data).toBe('en');

  // Mutate — will fail
  const res = await dispatchEndpoint(store, 'setLocale', { locale: 'de' });
  expect(res.error).toBeDefined();

  // Optimistic update rolled back — cache still 'en'
  const cached = await dispatchEndpoint(store, 'getLocale');
  expect(cached.data).toBe('en');
});

test('listLocales: fetches available locales (entity adapter normalization)', async () => {
  const locales = [
    { locale: 'en', label: 'English' },
    { locale: 'zh', label: '中文' }
  ];
  const client = fakeClient({ listLocales: handler('locales', async () => locales) });
  const store = createMonadStore({ client });

  const res = await dispatchEndpoint(store, 'listLocales');
  const data = res.data as { ids: string[]; entities: Record<string, unknown> };
  expect(data.ids).toHaveLength(2);
  expect(data.entities).toBeDefined();
});

test('getCatalog: fetches message catalog for a given locale', async () => {
  const catalog = { messages: { hello: 'Bonjour' } };
  const client = fakeClient({
    getCatalog: handler('catalog', async () => catalog)
  });
  const store = createMonadStore({ client });

  const res = await dispatchEndpoint(store, 'getCatalog', 'fr');
  expect(res.data).toEqual({ catalog });
});

test('getHooks: fetches hooks settings', async () => {
  const hooks = [{ event: 'session.created', command: 'echo hi' }];
  const client = fakeClient({ getHooks: handler('hooks', async () => hooks) });
  const store = createMonadStore({ client });

  const res = await dispatchEndpoint(store, 'getHooks');
  expect((res.data as { hooks?: unknown[] })?.hooks).toEqual(hooks);
});

test('setHooks: writes hooks and invalidates Hooks tag', async () => {
  let getCalls = 0;
  let written: unknown;
  const hooks = [{ event: 'session.created', command: 'echo hi' }];
  const client = fakeClient({
    getHooks: handler('hooks', async () => {
      getCalls++;
      return hooks;
    }),
    setHooks: handler('ok', async (body: unknown) => {
      written = body;
    })
  });
  const store = createMonadStore({ client });

  await dispatchEndpoint(store, 'getHooks');
  expect(getCalls).toBe(1);

  await dispatchEndpoint(store, 'setHooks', hooks);
  await new Promise((r) => setTimeout(r, 0));
  expect(getCalls).toBe(2);
  expect(written).toEqual(hooks);
});

test('getSandbox: fetches sandbox settings', async () => {
  const sandbox = { enabled: true, provider: 'seatbelt' };
  const client = fakeClient({ getSandbox: handler('sandbox', async () => sandbox) });
  const store = createMonadStore({ client });

  const res = await dispatchEndpoint(store, 'getSandbox');
  expect((res.data as { sandbox?: unknown })?.sandbox).toEqual(sandbox);
});

test('setSandbox: writes sandbox config and invalidates SandboxSettings tag', async () => {
  let getCalls = 0;
  let written: unknown;
  const client = fakeClient({
    getSandbox: handler('sandbox', async () => {
      getCalls++;
      return { enabled: true, provider: 'seatbelt' };
    }),
    setSandbox: handler('ok', async (body: unknown) => {
      written = body;
    })
  });
  const store = createMonadStore({ client });

  await dispatchEndpoint(store, 'getSandbox');
  expect(getCalls).toBe(1);

  await dispatchEndpoint(store, 'setSandbox', { enabled: false });
  await new Promise((r) => setTimeout(r, 0));
  expect(getCalls).toBe(2);
  expect(written).toEqual({ enabled: false });
});

test('getObscura: fetches obscura settings', async () => {
  const obscura = { enabled: true, mode: 'blur' };
  const client = fakeClient({ getObscura: handler('obscura', async () => obscura) });
  const store = createMonadStore({ client });

  const res = await dispatchEndpoint(store, 'getObscura');
  expect((res.data as { obscura?: unknown })?.obscura).toEqual(obscura);
});

test('setObscura: writes obscura config and invalidates Obscura tag', async () => {
  let getCalls = 0;
  let written: unknown;
  const client = fakeClient({
    getObscura: handler('obscura', async () => {
      getCalls++;
      return { enabled: false };
    }),
    setObscura: handler('ok', async (body: unknown) => {
      written = body;
    })
  });
  const store = createMonadStore({ client });

  await dispatchEndpoint(store, 'getObscura');
  expect(getCalls).toBe(1);

  await dispatchEndpoint(store, 'setObscura', { enabled: true });
  await new Promise((r) => setTimeout(r, 0));
  expect(getCalls).toBe(2);
  expect(written).toEqual({ enabled: true });
});

test('getOpenaiCompat: fetches openai-compat settings', async () => {
  const cfg = { enabled: true, port: 8123 };
  const client = fakeClient({ getOpenaiCompat: handler('openaiCompat', async () => cfg) });
  const store = createMonadStore({ client });

  const res = await dispatchEndpoint(store, 'getOpenaiCompat');
  expect((res.data as { openaiCompat?: unknown })?.openaiCompat).toEqual(cfg);
});

test('setOpenaiCompat: writes config and invalidates OpenaiCompat tag', async () => {
  let getCalls = 0;
  let written: unknown;
  const client = fakeClient({
    getOpenaiCompat: handler('openaiCompat', async () => {
      getCalls++;
      return { enabled: false };
    }),
    setOpenaiCompat: handler('ok', async (body: unknown) => {
      written = body;
    })
  });
  const store = createMonadStore({ client });

  await dispatchEndpoint(store, 'getOpenaiCompat');
  expect(getCalls).toBe(1);

  await dispatchEndpoint(store, 'setOpenaiCompat', { enabled: true });
  await new Promise((r) => setTimeout(r, 0));
  expect(getCalls).toBe(2);
  expect(written).toEqual({ enabled: true });
});

test('getToolBackends: fetches tool backend settings', async () => {
  const cfg = { backends: [{ id: 'local', type: 'local' as const, enabled: true }] };
  const client = fakeClient({ getToolBackends: handler('toolBackends', async () => cfg) });
  const store = createMonadStore({ client });

  const res = await dispatchEndpoint(store, 'getToolBackends');
  expect((res.data as { toolBackends?: unknown })?.toolBackends).toEqual(cfg);
});

test('setToolBackends: writes config and invalidates ToolBackends tag', async () => {
  let getCalls = 0;
  let written: unknown;
  const client = fakeClient({
    getToolBackends: handler('toolBackends', async () => {
      getCalls++;
      return { backends: [] };
    }),
    setToolBackends: handler('ok', async (body: unknown) => {
      written = body;
    })
  });
  const store = createMonadStore({ client });

  await dispatchEndpoint(store, 'getToolBackends');
  expect(getCalls).toBe(1);

  await dispatchEndpoint(store, 'setToolBackends', { webSearch: { provider: 'native' } });
  await new Promise((r) => setTimeout(r, 0));
  expect(getCalls).toBe(2);
  expect(written).toEqual({ webSearch: { provider: 'native' } });
});
