import { expect, test } from 'bun:test';

test('daemon boot registers workspace experiences from both atom-pack passes', async () => {
  const source = await Bun.file('apps/monad/src/main.ts').text();
  const bootRegistryCall = source.slice(
    source.indexOf('const channelRegistry = await createChannelRegistry'),
    source.indexOf('// Resolve bare atom-command names')
  );

  expect(bootRegistryCall).toContain('builtin:');
  expect(bootRegistryCall).toContain('discovered:');
  expect(bootRegistryCall.match(/onWorkspaceExperience:/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
});
