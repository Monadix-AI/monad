import { expect, test } from 'bun:test';

import { builtinConnectors, webhookConnector } from '../../src/connectors/index.ts';

test('webhook connector is registered', () => {
  expect(builtinConnectors).toContain(webhookConnector);
  expect(webhookConnector.name).toBe('webhook');
});
