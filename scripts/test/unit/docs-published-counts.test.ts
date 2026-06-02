import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');

const surfaces = ['README.md', 'README.zh-CN.md', 'docs/index.md', 'docs/guides/faq.md', 'docs/zh-Hans/guides/faq.md'];

const providerClaim = /(\d+)\s*(?:built-in provider types|built-in types)|内置 (\d+) 种提供方类型|(\d+) 种内置类型/;
const channelClaim = /(\d+)\s*(?:channel adapters|adapters, including)|(\d+) 个渠道适配器|(\d+) 个适配器/;

async function providerTypeCount(): Promise<number> {
  const source = await readFile(resolve(root, 'packages/protocol/src/rpc/control-model.ts'), 'utf8');
  const table = /export const KNOWN_PROVIDER_TYPES = \[([\s\S]*?)\] as const;/.exec(source)?.[1];
  if (!table) throw new Error('KNOWN_PROVIDER_TYPES table not found in packages/protocol/src/rpc/control-model.ts');
  return table.match(/ModelProviderType\.\w+/g)?.length ?? 0;
}

async function channelAdapterCount(): Promise<number> {
  const entries = await readdir(resolve(root, 'packages/atoms/src/channels'), { withFileTypes: true });
  const helpers = new Set(['icons.ts', 'setup-guides.ts']);
  return entries.filter(
    (entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.startsWith('_') && !helpers.has(entry.name)
  ).length;
}

async function documentedCounts(pattern: RegExp): Promise<Record<string, number>> {
  const entries = await Promise.all(
    surfaces.map(async (surface) => {
      const match = pattern.exec(await readFile(resolve(root, surface), 'utf8'));
      const claimed = match?.slice(1).find((group) => group !== undefined);
      return claimed === undefined ? null : ([surface, Number(claimed)] as const);
    })
  );
  return Object.fromEntries(entries.filter((entry) => entry !== null));
}

function expectedFor(documented: Record<string, number>, expected: number): Record<string, number> {
  return Object.fromEntries(Object.keys(documented).map((surface) => [surface, expected]));
}

describe('published capability counts', () => {
  test('documented provider counts match the protocol provider table', async () => {
    const [documented, expected] = await Promise.all([documentedCounts(providerClaim), providerTypeCount()]);
    expect(Object.keys(documented).length).toBeGreaterThan(0);
    // artifact-ok: the published number is the product claim; this audit names the exact file that drifted.
    expect(documented).toEqual(expectedFor(documented, expected));
  });

  test('documented channel-adapter counts match the shipped adapter set', async () => {
    const [documented, expected] = await Promise.all([documentedCounts(channelClaim), channelAdapterCount()]);
    expect(Object.keys(documented).length).toBeGreaterThan(0);
    // artifact-ok: the published number is the product claim; this audit names the exact file that drifted.
    expect(documented).toEqual(expectedFor(documented, expected));
  });
});
