import { expect, test } from 'bun:test';

import enWeb from '../../../../packages/i18n/src/locales/en/web.json';

test('external agent settings use user-facing External Agents naming', () => {
  expect(enWeb['web.externalAgent.title']).toBe('External Agents');
  expect(enWeb['web.externalAgent.addAgent']).toBe('Add external agent');
  expect(enWeb['web.studio.externalAgents']).toBe('External Agents');
  expect(enWeb['web.studio.connectExternalAgent']).toBe('Connect External Agents');
});
