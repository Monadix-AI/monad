import { expect, test } from 'bun:test';

import enWeb from '../../../../packages/i18n/src/locales/en/web.json';

test('external agent settings use user-facing External Agents naming', () => {
  expect(enWeb['web.nativeCli.title']).toBe('External Agents');
  expect(enWeb['web.nativeCli.addAgent']).toBe('Add external agent');
  expect(enWeb['web.studio.nativeCliAgents']).toBe('External Agents');
  expect(enWeb['web.studio.connectNativeCli']).toBe('Connect External Agents');
});
