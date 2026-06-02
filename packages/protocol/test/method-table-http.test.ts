import { expect, test } from 'bun:test';

import { METHOD_TABLE, type MethodName } from '../src/rpc/method-table.ts';
import {
  developerSettingsSchema,
  logCleanupPreviewSchema,
  logCleanupResultSchema,
  previewLogCleanupRequestSchema,
  setDeveloperSettingsRequestSchema
} from '../src/settings/developer-settings.ts';

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

test('developer log settings accept exact bounded whole-day policies', () => {
  expect(
    developerSettingsSchema.parse({
      developerMode: false,
      logsDir: '/tmp/logs',
      logs: { autoCleanup: { enabled: true, retentionDays: 14 } }
    })
  ).toEqual({
    developerMode: false,
    logsDir: '/tmp/logs',
    logs: { autoCleanup: { enabled: true, retentionDays: 14 } }
  });
  expect(
    setDeveloperSettingsRequestSchema.parse({ logs: { autoCleanup: { enabled: false, retentionDays: 30 } } })
  ).toEqual({ logs: { autoCleanup: { enabled: false, retentionDays: 30 } } });
  expect(previewLogCleanupRequestSchema.parse({ enabled: true, retentionDays: 1 })).toEqual({
    enabled: true,
    retentionDays: 1
  });
});

test('developer log request schemas reject invalid retention and unknown input', () => {
  const invalidRetentionDays = [0, 31, 1.5];
  expect(
    invalidRetentionDays.map(
      (retentionDays) =>
        setDeveloperSettingsRequestSchema.safeParse({
          logs: { autoCleanup: { enabled: true, retentionDays } }
        }).success
    )
  ).toEqual([false, false, false]);
  expect(
    previewLogCleanupRequestSchema.safeParse({ enabled: true, retentionDays: 14, path: '/private/log' }).success
  ).toBe(false);
});

test('cleanup wire schemas expose only aggregate result fields', () => {
  expect(logCleanupPreviewSchema.parse({ files: 3, bytes: 42 })).toEqual({ files: 3, bytes: 42 });
  expect(logCleanupResultSchema.parse({ filesCleared: 2, filesFailed: 1, bytesFreed: 42 })).toEqual({
    filesCleared: 2,
    filesFailed: 1,
    bytesFreed: 42
  });
  expect(
    logCleanupResultSchema.safeParse({
      filesCleared: 2,
      filesFailed: 1,
      bytesFreed: 42,
      paths: ['/private/log']
    }).success
  ).toBe(false);
});
