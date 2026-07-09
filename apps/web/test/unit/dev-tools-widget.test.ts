import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildDevToolActions } from '../../features/shell/DevToolsWidget';

test('dev tools widget builds project actions before dev server links', () => {
  const actions = buildDevToolActions({
    activeProjectId: 'proj_1',
    ports: {
      kv: '4111',
      aiSdk: '4222',
      otel: '4333'
    }
  });

  expect(actions.map((action) => action.label)).toEqual(['Developer Mode', 'Fix Impeccable', 'KV', 'AI SDK', 'OTel']);
  expect(actions.at(-1)?.href).toBe('http://localhost:4333');
});

test('dev tools widget keeps dev-only links out of production action data', () => {
  const actions = buildDevToolActions({
    activeProjectId: null,
    production: true,
    ports: {
      kv: '4111',
      aiSdk: '4222',
      otel: '4333'
    }
  });

  expect(actions.map((action) => action.label)).toEqual(['Fix Impeccable', 'OTel']);
});

test('app shell only imports DevToolsWidget behind the development guard', () => {
  const source = readFileSync(join(import.meta.dir, '../../pages/_app.tsx'), 'utf8');
  const guardIndex = source.indexOf("process.env.NODE_ENV === 'production'");
  const importIndex = source.indexOf("import('#/features/shell/DevToolsWidget')");

  expect(guardIndex).toBeGreaterThanOrEqual(0);
  expect(importIndex).toBeGreaterThan(guardIndex);
});
