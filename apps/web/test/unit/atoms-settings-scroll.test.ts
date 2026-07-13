import { expect, test } from 'bun:test';

const source = await Bun.file(new URL('../../src/features/studio/atoms-settings/index.tsx', import.meta.url)).text();

test('keeps the atom pack list scrollable inside the overflow-hidden Studio shell', () => {
  expect(source).toContain('<PanelShellBody className="overflow-y-auto">');
});
