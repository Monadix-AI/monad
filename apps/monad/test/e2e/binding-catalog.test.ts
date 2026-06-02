// Binding-catalog conformance (P0-A runtime track): every mounted live route has exactly one semantic
// owner. METHOD_TABLE owns request/response Methods (route-table-parity.test.ts guards that half); the
// non-Method half is the Stream planes (RUNTIME_STREAMS, including the global control WebSocket), the
// retained server-side UI projection (PRESENTATION_ROUTES), and the resource / protocol-adapter /
// extension-gateway / development registries (RESOURCE_OWNER_BINDINGS). A newly mounted route that is not
// registered in exactly one owner fails this test.

import { expect, test } from 'bun:test';
import {
  bindingRouteKey,
  DEVELOPMENT_ROUTES,
  EXTENSION_GATEWAY_ROUTES,
  HTTP_ROUTES,
  PRESENTATION_ROUTES,
  PROTOCOL_ADAPTER_ROUTES,
  RESOURCE_OWNER_BINDINGS,
  RESOURCE_ROUTES,
  RUNTIME_STREAMS,
  type RuntimeBindingDef,
  SEMANTIC_ROUTE_BINDINGS
} from '@monad/protocol';

import { createHttpTransport } from '#/transports/http.ts';
import { buildHandlers, mockModel } from '../helpers.ts';

type LiveRoute = { method: string; path: string; hooks?: { detail?: { tags?: string[] } } };

// Keep the WebSocket upgrade in scope — the control plane is a live route with a semantic owner and must
// not be a conformance blind spot. Only the CORS catch-all (OPTIONS) is excluded.
function liveRoutes(): LiveRoute[] {
  const app = createHttpTransport(buildHandlers(mockModel())) as unknown as { routes: LiveRoute[] };
  return app.routes.filter((r) => r.method !== 'OPTIONS');
}
const key = (r: LiveRoute): string => `${r.method} ${r.path}`;
const isHttpOnly = (r: LiveRoute): boolean => r.hooks?.detail?.tags?.includes('http-only') ?? false;

const bindings = Object.values(SEMANTIC_ROUTE_BINDINGS);

test('every RUNTIME_STREAMS / Presentation binding is a mounted live route (WebSocket included)', () => {
  const mounted = new Set(liveRoutes().map(key));
  const missing = bindings.map(bindingRouteKey).filter((k) => !mounted.has(k));
  expect(missing, 'cataloged bindings with no matching live route').toEqual([]);
});

test('GET stream/presentation bindings are non-Method http-only routes', () => {
  const tableRoutes = new Set(Object.values(HTTP_ROUTES).map((r) => `${r?.verb} ${r?.template}`));
  const live = new Map(liveRoutes().map((r) => [key(r), r] as const));
  const getBindings = bindings.filter((b) => b.method === 'GET');

  const methodOverlap = getBindings.map(bindingRouteKey).filter((k) => tableRoutes.has(k));
  expect(methodOverlap, 'a GET stream/presentation route must not also be a METHOD_TABLE Method').toEqual([]);

  const notHttpOnly = getBindings.map(bindingRouteKey).filter((k) => {
    const r = live.get(k);
    return r !== undefined && !isHttpOnly(r);
  });
  expect(notHttpOnly, "GET stream/presentation routes must carry detail.tags:['http-only']").toEqual([]);
});

test('the global control WebSocket /v1/stream is a mounted Stream-owned binding', () => {
  expect(bindings.find((b) => b.template === '/v1/stream')).toEqual({
    method: 'WS',
    template: '/v1/stream',
    owner: 'stream',
    capability: 'runtime.events'
  });
  expect(liveRoutes().map(key)).toContain('WS /v1/stream');
});

test('the provider auth-session SSE /v1/mesh/auth-sessions/:id/events is a mounted Stream-owned binding', () => {
  expect(bindings.find((b) => b.template === '/v1/mesh/auth-sessions/:id/events')).toEqual({
    method: 'GET',
    template: '/v1/mesh/auth-sessions/:id/events',
    owner: 'stream',
    capability: 'runtime.events'
  });
  expect(liveRoutes().map(key)).toContain('GET /v1/mesh/auth-sessions/:id/events');
});

test('the retained server-side UI projection is exactly the two Presentation-owned mounted routes', () => {
  // /ui-stream (SSE) + /ui-items (snapshot page) are a deliberate design surface, kept by decision.
  expect(Object.values(PRESENTATION_ROUTES)).toEqual([
    {
      method: 'GET',
      template: '/v1/sessions/:id/ui-stream',
      owner: 'presentation',
      capability: 'session.presentation'
    },
    { method: 'GET', template: '/v1/sessions/:id/ui-items', owner: 'presentation', capability: 'session.presentation' }
  ]);
  const liveKeys = liveRoutes().map(key);
  expect(liveKeys).toEqual(expect.arrayContaining(['GET /v1/sessions/:id/ui-stream', 'GET /v1/sessions/:id/ui-items']));
});

test('every RUNTIME_STREAMS entry is Stream-owned', () => {
  expect(Object.values(RUNTIME_STREAMS).map((b) => b.owner)).toEqual(
    Array(Object.keys(RUNTIME_STREAMS).length).fill('stream')
  );
});

// ── Full binding catalog: every mounted route has exactly one semantic owner ──────────────────

const methodOwnerKeys = Object.values(HTTP_ROUTES).map((r) => `${r?.verb} ${r?.template}`);
const semanticKeys = Object.values(SEMANTIC_ROUTE_BINDINGS).map(bindingRouteKey);
const resourceKeys = RESOURCE_OWNER_BINDINGS.map(bindingRouteKey);

test('every mounted live route has exactly one semantic owner (no orphan, no double-owner)', () => {
  const owners = new Map<string, number>();
  for (const k of [...methodOwnerKeys, ...semanticKeys, ...resourceKeys]) owners.set(k, (owners.get(k) ?? 0) + 1);
  const live = liveRoutes().map(key);
  const unowned = live.filter((k) => !owners.has(k));
  expect(unowned, 'mounted routes with no semantic owner — an unregistered route fails the catalog').toEqual([]);
  const doubleOwned = live.filter((k) => (owners.get(k) ?? 0) > 1);
  expect(doubleOwned, 'mounted routes claimed by more than one semantic owner').toEqual([]);
});

test('every semantic-owner binding is a mounted live route (no dangling catalog entry)', () => {
  // METHOD_TABLE↔live parity is guarded by route-table-parity.test.ts; this guards the Stream /
  // Presentation / resource / protocol-adapter / extension-gateway / development registries.
  const mounted = new Set(liveRoutes().map(key));
  const dangling = [...semanticKeys, ...resourceKeys].filter((k) => !mounted.has(k));
  expect(dangling, 'cataloged bindings with no matching live route').toEqual([]);
});

test('METHOD_TABLE and the semantic-owner registries are globally disjoint', () => {
  const methodSet = new Set(methodOwnerKeys);
  const overlap = [...semanticKeys, ...resourceKeys].filter((k) => methodSet.has(k));
  expect(overlap, 'a semantic-owner route must not also be a METHOD_TABLE Method').toEqual([]);
});

// Compile-time readonly lock (never executed): binding fields, the aggregate map's keys, and the
// resource array must all reject in-place mutation. Validated by tsc via the @ts-expect-error directives;
// kept out of a runtime test so it can't mutate the shared catalog.
function _catalogReadonlyGuards(binding: RuntimeBindingDef): void {
  // @ts-expect-error RuntimeBindingDef.owner is readonly
  binding.owner = 'resource';
  // @ts-expect-error SEMANTIC_ROUTE_BINDINGS is a Readonly<Record<...>> — keys cannot be reassigned
  SEMANTIC_ROUTE_BINDINGS.controlStream = binding;
  // @ts-expect-error RESOURCE_OWNER_BINDINGS is a readonly array
  RESOURCE_OWNER_BINDINGS.push(binding);
}
void _catalogReadonlyGuards;

test('each owner registry holds only bindings of its own owner (runtime lock over the type-level pin)', () => {
  const foreign = (rs: readonly { owner: string }[], owner: string): string[] =>
    rs.filter((b) => b.owner !== owner).map((b) => b.owner);
  expect(foreign(PROTOCOL_ADAPTER_ROUTES, 'protocol-adapter')).toEqual([]);
  expect(foreign(EXTENSION_GATEWAY_ROUTES, 'extension-gateway')).toEqual([]);
  expect(foreign(DEVELOPMENT_ROUTES, 'development')).toEqual([]);
  expect(foreign(RESOURCE_ROUTES, 'resource')).toEqual([]);
  // the developer-log SSE is owned by Development, not Resource.
  expect(DEVELOPMENT_ROUTES.map((b) => b.template)).toContain('/v1/sessions/:id/logs');
  expect(RESOURCE_ROUTES.map((b) => b.template)).not.toContain('/v1/sessions/:id/logs');
  // the aggregate is exactly the four registries with nothing dropped or duplicated.
  expect(RESOURCE_OWNER_BINDINGS.length).toBe(
    PROTOCOL_ADAPTER_ROUTES.length +
      EXTENSION_GATEWAY_ROUTES.length +
      DEVELOPMENT_ROUTES.length +
      RESOURCE_ROUTES.length
  );
});
