import { afterEach, expect, test } from 'bun:test';

import {
  __clearRemoteMarketplaceCacheForTest,
  createRemoteMarketplaceSources
} from '@/capabilities/skills/sources/marketplaces.ts';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  __clearRemoteMarketplaceCacheForTest();
});

function mockFetchText(body: string): void {
  globalThis.fetch = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
}

test('skills.sh marketplace parser reads Next flight escaped records', async () => {
  mockFetchText(
    '<script>self.__next_f.push([1,"{\\"allTimeSkills\\":[{\\"source\\":\\"owner/repo\\",\\"skillId\\":\\"alpha\\",\\"name\\":\\"Alpha\\",\\"installs\\":12,\\"weeklyInstalls\\":[1,2,3],\\"isOfficial\\":true}]}"])</script>'
  );

  const results = await createRemoteMarketplaceSources()['skills.sh'].browse?.('trending');

  expect(results).toEqual([
    {
      id: 'alpha',
      source: 'skills.sh',
      name: 'Alpha',
      description: 'owner/repo/alpha',
      score: null,
      version: null,
      downloads: 12,
      homepage: 'https://skills.sh/owner/repo/alpha',
      installSource: 'https://github.com/owner/repo?skill=alpha'
    }
  ]);
});

test('skills.sh marketplace parser keeps supporting raw embedded records', async () => {
  mockFetchText('{"source":"owner/repo","skillId":"beta","name":"Beta","installs":9,"weeklyInstalls":[0,4,5]}');

  const results = await createRemoteMarketplaceSources()['skills.sh'].browse?.('trending');

  expect(results?.[0]).toMatchObject({
    id: 'beta',
    source: 'skills.sh',
    name: 'Beta',
    downloads: 9,
    installSource: 'https://github.com/owner/repo?skill=beta'
  });
});

test('mcpservers.org marketplace search parses escaped skill records', async () => {
  mockFetchText(
    '<script>window.__DATA__="slug:\\"mattpocock/git-guardrails-claude-code\\",skillName:\\"git-guardrails-claude-code\\",name:\\"git-guardrails-claude-code\\",description:\\"Block dangerous git commands.\\",url:\\"https://github.com/mattpocock/skills/tree/HEAD/skills/git-guardrails-claude-code\\",downloadUrl:null,author:\\"mattpocock\\""</script>'
  );

  const results = await createRemoteMarketplaceSources()['mcpservers.org'].search?.('git', 'trending');

  expect(results).toEqual([
    {
      id: 'mattpocock/git-guardrails-claude-code',
      source: 'mcpservers.org',
      name: 'git-guardrails-claude-code',
      description: 'Block dangerous git commands.',
      score: null,
      version: null,
      downloads: null,
      homepage: 'https://mcpservers.org/agent-skills/mattpocock/git-guardrails-claude-code',
      installSource: 'https://github.com/mattpocock/skills/tree/HEAD/skills/git-guardrails-claude-code'
    }
  ]);
});
