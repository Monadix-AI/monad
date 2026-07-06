import { expect, test } from 'bun:test';

test('daemon boot registers workspace experiences from both atom-pack passes', async () => {
  const source = await Bun.file('src/bootstrap/main-init/atom-discovery.ts').text();
  const bootRegistryCall = source.slice(
    source.indexOf('const channelRegistry = await createChannelRegistry'),
    source.indexOf('return {')
  );

  expect(bootRegistryCall).toContain('builtin:');
  expect(bootRegistryCall).toContain('discovered:');
  expect(bootRegistryCall.match(/onWorkspaceExperience:/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
});
