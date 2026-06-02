// Dogfood: a model provider is a first-class atom kind. An atom pack declaring `provider`
// registers its ModelProvider through the SAME atom-kind-gated path (loadManifestAtomPack) as any
// channel/tool/command atom pack — and an atom pack that registers one WITHOUT declaring it is
// rejected.

import type { ModelChunk, ModelProvider } from '@monad/sdk-atom';

import { expect, test } from 'bun:test';
import { defineAtomPack, defineProvider, SDK_VERSION } from '@monad/sdk-atom';

import { type GatewayDeps, GatewayModelRouter, ModelProviderRegistry } from '@/agent/index.ts';
import { loadChannelAtomPacks } from '@/channels/atom-pack-host.ts';

const fakeProviderAtom = defineProvider({
  type: 'fake',
  descriptor: { type: 'fake', label: 'Fake', strategy: 'native' },
  // biome-ignore lint/correctness/useYield: throw-only stub
  async *stream() {
    throw new Error('not used in this test');
  }
});

test('an atom pack declaring the provider atom kind registers its provider', async () => {
  const got: ModelProvider[] = [];
  await loadChannelAtomPacks(
    [
      defineAtomPack({
        manifest: { name: 'p', version: '1.0.0', sdkVersion: SDK_VERSION, atoms: ['provider'] },
        providers: [fakeProviderAtom]
      })
    ],
    { onProvider: (p) => got.push(p) }
  );
  expect(got).toHaveLength(1);
  expect(got[0]?.type).toBe('fake');
  expect(got[0]?.descriptor.label).toBe('Fake');
});

test('registering a provider without declaring the atom kind is rejected (UndeclaredAtomError)', async () => {
  const errors: { atomPack: string; error: unknown }[] = [];
  await loadChannelAtomPacks(
    [
      defineAtomPack({
        manifest: { name: 'sneaky', version: '1.0.0', sdkVersion: SDK_VERSION, atoms: [] },
        providers: [fakeProviderAtom]
      })
    ],
    { onProvider: () => {}, onError: (atomPack, error) => errors.push({ atomPack, error }) }
  );
  expect(errors[0]?.atomPack).toBe('sneaky');
  expect((errors[0]?.error as Error).name).toBe('UndeclaredAtomError');
});

test('a discovered provider atom pack is registered into the registry and usable by the gateway', async () => {
  // Full chain: loadChannelAtomPacks → onProvider sink → ModelProviderRegistry → GatewayModelRouter.
  const providerAtom = defineProvider({
    type: 'e2e',
    descriptor: { type: 'e2e', label: 'E2E', strategy: 'native' },
    async *stream(): AsyncIterable<ModelChunk> {
      yield { type: 'text', token: 'routed' };
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
    }
  });

  const registry = new ModelProviderRegistry();
  await loadChannelAtomPacks(
    [
      defineAtomPack({
        manifest: { name: 'e2e', version: '1.0.0', sdkVersion: SDK_VERSION, atoms: ['provider'] },
        providers: [providerAtom]
      })
    ],
    { onProvider: (p) => registry.register(p) }
  );
  expect(registry.has('e2e')).toBe(true);

  const deps: GatewayDeps = {
    providers: [{ id: 'e2e', type: 'e2e' }],
    profiles: [{ alias: 'default', provider: 'e2e', modelId: 'm', params: {}, fallbacks: [] }],
    defaultProfile: 'default',
    credentialsFor: () => [{ id: 'c1', accessToken: 'k', authType: 'api_key', priority: 0 }]
  };
  const router = new GatewayModelRouter(deps, registry);
  const result = await router.complete({ model: 'default', messages: [{ role: 'user', content: 'hi' }] });
  expect(result.text).toBe('routed'); // the atom-pack-registered provider actually served the turn
  expect(result.usage?.provider).toBe('e2e');
});
