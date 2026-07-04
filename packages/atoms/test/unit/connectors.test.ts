import { expect, test } from 'bun:test';

import { builtinConnectors } from '../../src/connectors/registry.ts';
import { webhookConnector } from '../../src/connectors/webhook.ts';

test('webhook connector is registered', () => {
  expect(builtinConnectors).toContain(webhookConnector);
  expect(webhookConnector.name).toBe('webhook');
});
