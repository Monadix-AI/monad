// Tests for connector and model provider capability gates in sdk-atom.
// These are security boundaries: registrations of undeclared atom kinds must
// throw UndeclaredAtomError regardless of what the pack's manifest self-declares.

import type { Connector, ConnectorHost } from '../../src/connector.ts';
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

const dummyConnector: Connector = {
  name: 'test-connector',
  scopes: [],
  start: async (_host: ConnectorHost) => {},
  stop: async () => {}
};

const dummyProvider: ModelProvider = defineProvider({
  type: 'test',
  descriptor: {
    label: 'Test Provider',
    type: 'test',
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
  connectors: Connector[];
  providers: ModelProvider[];
} {
  const connectors: Connector[] = [];
  const providers: ModelProvider[] = [];
  return {
    connectors,
    providers,
    registerConnector: (c) => connectors.push(c as Connector),
    registerChannel: () => {},
    registerCommand: () => {},
    registerMessageType: () => {},
    registerHook: () => {},
    registerProvider: (p) => providers.push(p as ModelProvider)
  };
}

// ── connector gate ─────────────────────────────────────────────────────────────

test('connector: declared pack registers without error', async () => {
  const pack = defineAtomPack({
    manifest: manifest({ atoms: ['connector'] }),
    connectors: [dummyConnector]
  });
  const host = collectingHost();
  await loadManifestAtomPack(pack, host);
  expect(host.connectors).toHaveLength(1);
  expect(host.connectors[0]?.name).toBe('test-connector');
});

test('connector: undeclared pack throws UndeclaredAtomError', async () => {
  const pack = defineAtomPack({
    manifest: manifest({ atoms: [] }), // no 'connector' declared
    connectors: [dummyConnector]
  });
  const host = collectingHost();
  await expect(loadManifestAtomPack(pack, host)).rejects.toBeInstanceOf(UndeclaredAtomError);
});

test('connector: grantedAtoms overrides self-declared manifest (consent enforcement)', async () => {
  // Pack self-declares 'connector' in manifest, but host only granted [] — must be blocked.
  const pack = defineAtomPack({
    manifest: manifest({ atoms: ['connector'] }),
    connectors: [dummyConnector]
  });
  const host = collectingHost();
  await expect(loadManifestAtomPack(pack, host, { grantedAtoms: [] })).rejects.toBeInstanceOf(UndeclaredAtomError);
});

test('connector: grantedAtoms with connector allows registration', async () => {
  // grantedAtoms has 'connector' even though manifest says [] — grantedAtoms is authoritative.
  const pack = defineAtomPack({
    manifest: manifest({ atoms: [] }),
    connectors: [dummyConnector]
  });
  const host = collectingHost();
  await loadManifestAtomPack(pack, host, { grantedAtoms: ['connector'] });
  expect(host.connectors).toHaveLength(1);
});

test('connector: UndeclaredAtomError message identifies the atom kind and pack name', async () => {
  const pack = defineAtomPack({
    manifest: manifest({ name: 'shady-pack', atoms: [] }),
    connectors: [dummyConnector]
  });
  const host = collectingHost();
  let caught: unknown;
  try {
    await loadManifestAtomPack(pack, host);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(UndeclaredAtomError);
  const msg = (caught as UndeclaredAtomError).message;
  expect(msg).toContain('connector');
  expect(msg).toContain('shady-pack');
});

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
  // User consented to connector but NOT provider — must block.
  await expect(loadManifestAtomPack(pack, host, { grantedAtoms: ['connector'] })).rejects.toBeInstanceOf(
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

// ── connector interface ────────────────────────────────────────────────────────

test('connector: start and stop are callable', async () => {
  const started: string[] = [];
  const stopped: string[] = [];
  const connector: Connector = {
    name: 'lifecycle',
    scopes: [],
    start: async (_host) => {
      started.push('started');
    },
    stop: async () => {
      stopped.push('stopped');
    }
  };
  const host: ConnectorHost = {
    ingest: async (input) => ({ sessionId: `ses_${input.text}` })
  };
  await connector.start(host);
  await connector.stop();
  expect(started).toEqual(['started']);
  expect(stopped).toEqual(['stopped']);
});

test('connector host: ingest returns a sessionId', async () => {
  const host: ConnectorHost = {
    ingest: async (_input) => ({ sessionId: 'ses_test' })
  };
  const result = await host.ingest({ text: 'hello', sessionId: 'ses_existing' });
  expect(result.sessionId).toBe('ses_test');
});
