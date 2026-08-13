// Tests for the model provider capability gate.
// These are security boundaries: registrations of undeclared atom kinds must
// throw UndeclaredAtomError regardless of what the pack's manifest self-declares.

import type { AtomPackManifest, ManifestAtomPackHost } from '../../src/index.ts';
import type { ModelProvider } from '../../src/model.ts';

import { expect, test } from 'bun:test';

import {
  defineAtomPack,
  defineProvider,
  loadManifestAtomPack,
  SDK_VERSION,
  UndeclaredAtomError
} from '../../src/index.ts';

// ── fixtures ───────────────────────────────────────────────────────────────────

function manifest(over: Partial<AtomPackManifest>): AtomPackManifest {
  return { name: 'test-pack', version: '1.0.0', sdkVersion: SDK_VERSION, atoms: [], ...over };
}

const dummyProvider: ModelProvider = defineProvider({
  type: 'test',
  descriptor: {
    label: 'Test Provider',
    type: 'test',
    icon: { title: 'Test Provider', path: 'M4 4h16v16H4z' },
    strategy: 'openai-compatible',
    defaultBaseUrl: 'https://api.test.example.com',
    keyPlaceholder: 'test-key-xxx'
  },
  stream: async function* (_call) {
    yield { type: 'text' as const, token: 'hello' };
    yield { type: 'finish' as const, reason: 'stop' };
    yield { type: 'usage' as const, usage: { inputTokens: 1, outputTokens: 1 } };
  }
});

function collectingHost(): ManifestAtomPackHost & {
  providers: ModelProvider[];
} {
  const providers: ModelProvider[] = [];
  return {
    providers,
    registerChannel: () => {},
    registerCommand: () => {},
    registerMessageType: () => {},
    registerHook: () => {},
    registerProvider: (p) => providers.push(p as ModelProvider)
  };
}

// ── provider (model) gate ──────────────────────────────────────────────────────

test('provider: declared pack registers without error', async () => {
  const pack = defineAtomPack({
    manifest: manifest({ atoms: ['provider'] }),
    providers: [dummyProvider]
  });
  const host = collectingHost();
  await loadManifestAtomPack(pack, host);
  expect(host.providers).toHaveLength(1);
  expect(host.providers[0]?.type).toBe('test');
});

test('provider: undeclared pack throws UndeclaredAtomError', async () => {
  const pack = defineAtomPack({
    manifest: manifest({ atoms: [] }),
    providers: [dummyProvider]
  });
  const host = collectingHost();
  await expect(loadManifestAtomPack(pack, host)).rejects.toBeInstanceOf(UndeclaredAtomError);
});

test('provider: grantedAtoms overrides self-declared manifest for model atoms', async () => {
  const pack = defineAtomPack({
    manifest: manifest({ atoms: ['provider'] }),
    providers: [dummyProvider]
  });
  const host = collectingHost();
  // User consented to channel but NOT provider — must block.
  await expect(loadManifestAtomPack(pack, host, { grantedAtoms: ['channel'] })).rejects.toBeInstanceOf(
    UndeclaredAtomError
  );
});

test('provider: multiple providers all require model grant', async () => {
  const provider2 = defineProvider({ ...dummyProvider, type: 'test2' });
  const pack = defineAtomPack({
    manifest: manifest({ atoms: [] }),
    providers: [dummyProvider, provider2]
  });
  const host = collectingHost();
  await expect(loadManifestAtomPack(pack, host)).rejects.toBeInstanceOf(UndeclaredAtomError);
});

// ── defineProvider identity ────────────────────────────────────────────────────

test('defineProvider: returns the same provider object (identity helper)', () => {
  const provider = defineProvider(dummyProvider);
  expect(provider).toBe(dummyProvider);
});

test('defineProvider: stream is callable and yields chunks', async () => {
  const chunks: string[] = [];
  const call = {
    modelId: 'test-model',
    messages: [{ role: 'user' as const, content: 'hi' }],
    params: {},
    provider: { id: 'test', type: 'test' },
    credential: { id: 'cred_1', accessToken: 'key', authType: 'api_key' as const, priority: 0 }
  };
  if (!dummyProvider.stream) throw new Error('dummy provider missing stream');
  for await (const chunk of dummyProvider.stream(call)) {
    chunks.push(chunk.type);
  }
  expect(chunks).toContain('finish');
  expect(chunks).toContain('usage');
});
