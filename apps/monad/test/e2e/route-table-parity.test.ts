// Drift guard: the REST verb+URL of every shared method lives in @monad/protocol's
// METHOD_TABLE (HTTP_ROUTES). This test mounts the real daemon HTTP app and asserts the
// live Elysia routes match the table EXACTLY — neither side can drift from the other.
//
// Routes that are deliberately HTTP-only (streaming, push, settings surfaces with no JSON-RPC
// counterpart) declare themselves at the route via `detail.tags: ['http-only']` — fully-HTTP-only
// controllers set it once on the Elysia instance (`new Elysia({ tags: ['http-only'] })`), mixed
// controllers tag the individual route. The test derives the exemption set from those tags, so
// adding an HTTP-only endpoint needs no edit here — but adding ANY route without either a
// METHOD_TABLE entry or the tag fails on purpose: the "no silent HTTP-only endpoint" guarantee.

import { expect, test } from 'bun:test';
import { HTTP_ROUTES } from '@monad/protocol';

import { createHttpTransport } from '@/transports/http.ts';
import { buildHandlers, mockModel } from '../helpers.ts';

type LiveRoute = { method: string; path: string; hooks?: { detail?: { tags?: string[] } } };

/** `VERB /path` strings for the methods that declare a REST binding. */
function tableRoutes(): Set<string> {
  return new Set(Object.values(HTTP_ROUTES).map((r) => `${r?.verb} ${r?.template}`));
}

/** Live Elysia routes (excluding the CORS catch-all and the WebSocket upgrade) with their tags. */
function liveRoutes(): LiveRoute[] {
  const app = createHttpTransport(buildHandlers(mockModel())) as unknown as { routes: LiveRoute[] };
  return app.routes.filter((r) => r.method !== 'OPTIONS' && r.method !== 'WS');
}

const key = (r: LiveRoute) => `${r.method} ${r.path}`;
const isHttpOnly = (r: LiveRoute) => r.hooks?.detail?.tags?.includes('http-only') ?? false;

test('every METHOD_TABLE http binding is a live route', () => {
  const mounted = new Set(liveRoutes().map(key));
  const missing = [...tableRoutes()].filter((r) => !mounted.has(r));
  expect(missing, 'table routes with no matching controller route').toEqual([]);
});

test('every live route is either table-derived or tagged http-only', () => {
  const table = tableRoutes();
  const undocumented = liveRoutes()
    .filter((r) => !table.has(key(r)) && !isHttpOnly(r))
    .map(key);
  expect(undocumented, "routes missing from METHOD_TABLE and not tagged detail.tags:['http-only']").toEqual([]);
});

test('no route is both table-derived and tagged http-only', () => {
  const table = tableRoutes();
  const mistagged = liveRoutes()
    .filter((r) => table.has(key(r)) && isHttpOnly(r))
    .map(key);
  expect(mistagged, 'universal (RPC-twinned) routes must not carry the http-only tag').toEqual([]);
});
