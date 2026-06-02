import { expect, test } from 'bun:test';

import { buildDevToolActions } from '../../src/features/shell/DevToolsWidget';

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
