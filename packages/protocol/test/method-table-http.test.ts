import { expect, test } from 'bun:test';

import { HTTP_ROUTES, METHOD_TABLE, type MethodName } from '../src/rpc/method-table.ts';

const entries = Object.entries(METHOD_TABLE) as [MethodName, (typeof METHOD_TABLE)[MethodName]][];

/** `:param` placeholders in a URL template. */
function placeholders(template: string): string[] {
  return [...template.matchAll(/:(\w+)/g)].map((m) => m[1] as string);
}

test('every HTTP route template starts at root and uses a known verb', () => {
  for (const [method, def] of entries) {
    if (!('http' in def) || !def.http) continue;
    expect(def.http.template, `${method}.http.template`).toMatch(/^\//);
    expect(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], `${method}.http.verb`).toContain(def.http.verb);
  }
});

test('template placeholders are exactly the method path keys', () => {
  for (const [method, def] of entries) {
    if (!('http' in def) || !def.http) continue;
    const inTemplate = placeholders(def.http.template).sort();
    const pathKeys = Object.keys('path' in def && def.path ? def.path : {}).sort();
    // Every `:param` must be a declared path key, and every path key must appear in the URL —
    // this is what guarantees the HTTP `:id`/`:credId` names can't drift from the wire params.
    expect(inTemplate, `${method}: placeholders vs path keys`).toEqual(pathKeys);
  }
});

test('no two methods bind the same (verb, template)', () => {
  const seen = new Map<string, MethodName>();
  for (const [method, def] of entries) {
    if (!('http' in def) || !def.http) continue;
    const key = `${def.http.verb} ${def.http.template}`;
    expect(seen.has(key), `${method} collides with ${seen.get(key)} on "${key}"`).toBe(false);
    seen.set(key, method);
  }
});

test('HTTP_ROUTES is derived for exactly the methods that declare http', () => {
  const declared = entries.filter(([, def]) => 'http' in def && def.http).map(([m]) => m);
  expect(Object.keys(HTTP_ROUTES).sort()).toEqual([...declared].sort());
  // control.subscribe/unsubscribe are RPC/stream-only and must NOT get a REST binding.
  for (const m of ['control.subscribe', 'control.unsubscribe'] as const) {
    expect(HTTP_ROUTES[m], `${m} must be RPC-only`).toBeUndefined();
  }
});
