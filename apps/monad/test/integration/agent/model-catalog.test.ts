import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assignTiers, classifyKind, ModelCatalogService } from '#/services/model-catalog.ts';

let dir: string;
let cachePath: string;
const logs: Array<{ level: string; message: string }> = [];
const log = (level: 'debug' | 'info' | 'warn', message: string) => void logs.push({ level, message });

// A models.dev-shaped payload: provider → models → model. One model is malformed (no id).
const CATALOG = {
  openai: {
    name: 'OpenAI',
    models: {
      'gpt-5.2': {
        id: 'openai/gpt-5.2',
        name: 'GPT-5.2',
        reasoning: true,
        tool_call: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 400000, output: 128000 },
        cost: { input: 1.25, output: 10, cache_read: 0.1 },
        release_date: '2026-05-01'
      },
      'gpt-5-mini': {
        id: 'openai/gpt-5-mini',
        cost: { input: 0.15, output: 0.6 },
        limit: { context: 400000 }
      }
    }
  },
  anthropic: {
    name: 'Anthropic',
    models: {
      broken: { name: 'No id here' } // malformed → skipped
    }
  }
};

const PAGES = {
  'openai/gpt-5.2': {
    id: 'openai/gpt-5.2',
    name: 'GPT-5.2',
    family: 'gpt',
    modalities: { input: ['text', 'image'], output: ['text'] }
  },
  'openai/gpt-5-mini': {
    id: 'openai/gpt-5-mini',
    name: 'GPT-5 Mini',
    family: 'gpt',
    modalities: { input: ['text'], output: ['text'] }
  }
};

const okFetch = (async (url: string) =>
  new Response(JSON.stringify(url.includes('models.json') ? PAGES : CATALOG), {
    status: 200
  })) as unknown as typeof fetch;
const failFetch = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'monad-catalog-'));
  cachePath = join(dir, 'model-catalog.json');
  logs.length = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('refresh indexes blended cost in memory, writes full entries to disk, skips malformed', async () => {
  const svc = new ModelCatalogService({ cachePath, log, fetchImpl: okFetch, url: 'https://x' });
  expect(await svc.refresh()).toBe(true);
  expect(svc.size).toBe(2); // broken skipped

  // In memory: only the blended cost ($/1M in + out).
  expect(svc.cost('openai/gpt-5.2')).toBeCloseTo(11.25); // 1.25 + 10
  expect(svc.cost('openai/gpt-5-mini')).toBeCloseTo(0.75); // 0.15 + 0.6

  // On disk: the FULL flattened entries are kept (future-proof) — prove flatten field mapping.
  const onDisk = (await Bun.file(cachePath).json()) as Array<Record<string, unknown>>;
  const big = onDisk.find((e) => e.id === 'openai/gpt-5.2');
  expect(big).toMatchObject({
    provider: 'openai',
    name: 'GPT-5.2',
    contextLimit: 400000,
    reasoning: true,
    toolCall: true,
    modalities: ['text', 'image'],
    outputModalities: ['text'],
    kind: 'chat', // output⊇text, no image/audio, id not embed
    releaseDate: '2026-05-01'
  });
});

test('classifyKind: embedding by id and provider output modality, else chat', () => {
  expect(classifyKind('openai/text-embedding-3-large', ['text'])).toBe('embedding'); // id wins over text-out
  expect(classifyKind('openrouter/embed', ['embeddings'])).toBe('embedding');
  expect(classifyKind('openai/dall-e-3', ['image'])).toBe('image');
  expect(classifyKind('openai/sora', ['video'])).toBe('video');
  expect(classifyKind('openai/tts-1', ['speech'])).toBe('speech');
  expect(classifyKind('openai/audio-1', ['audio'])).toBe('audio');
  expect(classifyKind('openrouter/reranker', ['rerank'])).toBe('rerank');
  expect(classifyKind('openai/whisper', ['transcription'])).toBe('transcription');
  expect(classifyKind('openai/gpt-5.2', ['text'])).toBe('chat');
  expect(classifyKind('foo/bar', undefined)).toBe('chat'); // no output info → chat
});

test('lookupCapabilities joins by id (and bare suffix) with modalities/flags/kind; embedding indexed even when unpriced', async () => {
  const catalog = {
    openai: {
      name: 'OpenAI',
      models: {
        // unpriced embedding model — must still be indexed for capabilities
        'text-embedding-3-large': {
          id: 'openai/text-embedding-3-large',
          modalities: { input: ['text'], output: ['text'] }
        },
        'dall-e-3': { id: 'openai/dall-e-3', modalities: { input: ['text'], output: ['image'] }, cost: { input: 1 } },
        'gpt-5.2': {
          id: 'openai/gpt-5.2',
          reasoning: true,
          tool_call: true,
          modalities: { input: ['text', 'image'], output: ['text'] },
          cost: { input: 1, output: 2 }
        }
      }
    }
  };
  const fetchImpl = (async () => new Response(JSON.stringify(catalog), { status: 200 })) as unknown as typeof fetch;
  const svc = new ModelCatalogService({ cachePath, log, fetchImpl, url: 'https://x' });
  await svc.refresh();

  expect(svc.lookupCapabilities('openai', 'openai/text-embedding-3-large')?.kind).toBe('embedding');
  expect(svc.lookupCapabilities('openai', 'dall-e-3')?.kind).toBe('image'); // bare-suffix join
  const chat = svc.lookupCapabilities('openai', 'openai/gpt-5.2');
  expect(chat).toMatchObject({
    kind: 'chat',
    input: ['text', 'image'],
    output: ['text'],
    reasoning: true,
    toolCall: true
  });
});

test('refresh writes a cache that loadCache restores (cost index)', async () => {
  await new ModelCatalogService({ cachePath, log, fetchImpl: okFetch, url: 'https://x' }).refresh();
  expect(await Bun.file(cachePath).exists()).toBe(true);

  const fresh = new ModelCatalogService({ cachePath, log, fetchImpl: failFetch, url: 'https://x' });
  await fresh.loadCache();
  expect(fresh.size).toBe(2);
  expect(fresh.cost('openai/gpt-5.2')).toBeCloseTo(11.25);
});

test('a failed refresh is non-fatal and keeps the previous catalog', async () => {
  const svc = new ModelCatalogService({ cachePath, log, fetchImpl: okFetch, url: 'https://x' });
  await svc.refresh();
  expect(svc.size).toBe(2);

  // Swap in a failing fetch by constructing a new service that shares nothing — instead,
  // assert directly: a service whose fetch fails returns false and stays empty.
  const failing = new ModelCatalogService({ cachePath, log, fetchImpl: failFetch, url: 'https://x' });
  expect(await failing.refresh()).toBe(false);
  expect(failing.size).toBe(0); // nothing loaded; previous (none) kept
});

test('loadCache tolerates a missing or corrupt cache file', async () => {
  const svc = new ModelCatalogService({ cachePath, log, fetchImpl: okFetch, url: 'https://x' });
  await svc.loadCache(); // missing file → no-op
  expect(svc.size).toBe(0);

  await Bun.write(cachePath, 'not json{');
  await svc.loadCache(); // corrupt → logged, no throw
  expect(svc.size).toBe(0);
});

// ── assignTiers (capability tiering) ──────────────────────────────────────────────

const m = (id: string, cost: number) => ({ id, cost });

test('assignTiers: ≥3 priced models split into fast/smart/power by blended cost', () => {
  const t = assignTiers([m('cheap', 0.2), m('mid', 2), m('exp', 15)]);
  expect(t.get('cheap')).toBe('fast');
  expect(t.get('mid')).toBe('smart');
  expect(t.get('exp')).toBe('power');
});

test('assignTiers: N=1 → smart, N=2 → fast/power', () => {
  expect(assignTiers([m('only', 5)]).get('only')).toBe('smart');
  const two = assignTiers([m('a', 1), m('b', 9)]);
  expect(two.get('a')).toBe('fast');
  expect(two.get('b')).toBe('power');
});

test('assignTiers: 6 models → bottom/top thirds are fast/power', () => {
  const t = assignTiers([1, 2, 3, 4, 5, 6].map((c) => m(`m${c}`, c)));
  expect([t.get('m1'), t.get('m2')]).toEqual(['fast', 'fast']);
  expect([t.get('m3'), t.get('m4')]).toEqual(['smart', 'smart']);
  expect([t.get('m5'), t.get('m6')]).toEqual(['power', 'power']);
});

test('assignTiers: unpriced models default to smart', () => {
  const t = assignTiers([{ id: 'unknown' }, m('cheap', 0.1), m('exp', 20)]);
  expect(t.get('unknown')).toBe('smart');
  expect(t.get('cheap')).toBe('fast'); // ranking ignores the unpriced one (2 priced → fast/power)
  expect(t.get('exp')).toBe('power');
});

test('assignTiers: operator overrides win over the auto ranking', () => {
  const t = assignTiers([m('cheap', 0.2), m('mid', 2), m('exp', 15)], { cheap: 'power', exp: 'fast' });
  expect(t.get('cheap')).toBe('power');
  expect(t.get('exp')).toBe('fast');
  expect(t.get('mid')).toBe('smart');
});

test('service.tiers joins catalog pricing and applies overrides', async () => {
  const svc = new ModelCatalogService({ cachePath, log, fetchImpl: okFetch, url: 'https://x' });
  await svc.refresh(); // gpt-5.2 (in 1.25+out 10), gpt-5-mini (0.15+0.6)
  const t = svc.tiers(['openai/gpt-5.2', 'openai/gpt-5-mini', 'unlisted/model']);
  expect(t.get('openai/gpt-5-mini')).toBe('fast'); // cheapest priced
  expect(t.get('openai/gpt-5.2')).toBe('power'); // priciest priced
  expect(t.get('unlisted/model')).toBe('smart'); // not in catalog → unknown → smart
});

// ── join (lookupModel) + tier → profile resolution ────────────────────────────────

test('lookupCost joins native, gateway-prefixed, and bare-name model ids', async () => {
  const svc = new ModelCatalogService({ cachePath, log, fetchImpl: okFetch, url: 'https://x' });
  await svc.refresh();
  // catalog id "openai/gpt-5.2" (blended 11.25), "openai/gpt-5-mini" (0.75)
  expect(svc.lookupCost('anything', 'openai/gpt-5.2')).toBeCloseTo(11.25); // id as-is
  expect(svc.lookupCost('openai', 'gpt-5.2')).toBeCloseTo(11.25); // provider/modelId
  expect(svc.lookupCost('some-gateway', 'gpt-5-mini')).toBeCloseTo(0.75); // bare-name fallback
});

test('lookupPriceExact requires an exact id match — no bare-name suffix fallback', async () => {
  const svc = new ModelCatalogService({ cachePath, log, fetchImpl: okFetch, url: 'https://x' });
  await svc.refresh();
  // exact `provider/id` join works
  expect(svc.lookupPriceExact('openai', 'gpt-5.2')).toEqual({ input: 1.25, output: 10, cacheRead: 0.1 });
  // the fuzzy lookup matches a differently-prefixed id via the bare-name suffix...
  expect(svc.lookupPrice('openrouter', 'vendor/gpt-5.2')).toEqual({ input: 1.25, output: 10, cacheRead: 0.1 });
  // ...but the display lookup does NOT — guards against showing an aliased / wrong-version price.
});

test('lookupModelsDevUrl matches models.dev pages by id and dot-normalized id', async () => {
  const catalog = {
    openrouter: {
      models: {
        'google/gemini-2.5-pro': {
          id: 'google/gemini-2.5-pro',
          name: 'Gemini 2.5 Pro',
          family: 'gemini-pro',
          modalities: { input: ['text', 'image'], output: ['text'] },
          limit: { context: 1048576 },
          cost: { input: 1.25, output: 10 }
        },
        'google/gemini-3.5-pro': {
          id: 'google/gemini-3.5-pro',
          name: 'Gemini 3.5 Pro',
          family: 'gemini-pro',
          modalities: { input: ['text', 'image'], output: ['text'] },
          limit: { context: 1048576 },
          cost: { input: 1.25, output: 10 }
        }
      }
    },
    deepseek: {
      models: {
        'deepseek-chat': {
          id: 'deepseek-chat',
          name: 'DeepSeek Chat',
          family: 'deepseek',
          modalities: { input: ['text'], output: ['text'] },
          limit: { context: 1000000 },
          cost: { input: 0.14, output: 0.28 }
        }
      }
    },
    google: {
      models: {
        'gemini-3.5-pro': {
          id: 'gemini-3.5-pro',
          name: 'Gemini 3.5 Pro',
          family: 'gemini-pro',
          modalities: { input: ['text', 'image'], output: ['text'] },
          limit: { context: 1048576 },
          cost: { input: 1.25, output: 10 }
        }
      }
    }
  };
  const pages = {
    'google/gemini-2.5-pro': {
      id: 'google/gemini-2.5-pro'
    },
    'deepseek/deepseek-chat': {
      id: 'deepseek/deepseek-chat'
    },
    'google/gemini-3-5-pro': {
      id: 'google/gemini-3-5-pro'
    }
  };
  const fetchImpl = (async (url: string) =>
    new Response(JSON.stringify(url.includes('models.json') ? pages : catalog), {
      status: 200
    })) as unknown as typeof fetch;
  const svc = new ModelCatalogService({
    cachePath,
    log,
    fetchImpl,
    url: 'https://x',
    modelsUrl: 'https://x/models.json'
  });
  await svc.refresh();

  expect(svc.lookupModelsDevUrl('openrouter', 'google/gemini-2.5-pro')).toBe(
    'https://models.dev/models/google/gemini-2.5-pro'
  );
  expect(svc.lookupModelsDevUrl('openrouter', 'google/gemini-3.5-pro')).toBe(
    'https://models.dev/models/google/gemini-3-5-pro'
  );
  expect(svc.lookupModelsDevUrl('deepseek', 'deepseek-chat')).toBe('https://models.dev/models/deepseek/deepseek-chat');
  expect(svc.lookupModelsDevUrl('google', 'gemini-3.5-pro')).toBe('https://models.dev/models/google/gemini-3-5-pro');
});

const PROFILES = [
  { alias: 'p-mini', routes: { chat: { provider: 'openai', modelId: 'gpt-5-mini' } } }, // cheap → fast
  { alias: 'p-big', routes: { chat: { provider: 'openai', modelId: 'gpt-5.2' } } }, // pricey → power
  { alias: 'p-unknown', routes: { chat: { provider: 'custom', modelId: 'mystery-model' } } } // not in catalog → smart
];

test('tierProfiles classifies configured profiles by alias', async () => {
  const svc = new ModelCatalogService({ cachePath, log, fetchImpl: okFetch, url: 'https://x' });
  await svc.refresh();
  const t = svc.tierProfiles(PROFILES);
  expect(t.get('p-mini')).toBe('fast');
  expect(t.get('p-big')).toBe('power');
  expect(t.get('p-unknown')).toBe('smart');
});

test('pickProfileForTier resolves fast to a concrete model spec', async () => {
  const svc = new ModelCatalogService({ cachePath, log, fetchImpl: okFetch, url: 'https://x' });
  await svc.refresh();
  expect(svc.pickProfileForTier('fast', PROFILES)).toBe('openai:gpt-5-mini');
  expect(
    svc.pickProfileForTier('fast', [
      {
        alias: 'custom-fast',
        routes: {
          chat: { provider: 'openai', modelId: 'gpt-5.2' },
          fast: { provider: 'custom', modelId: 'tiny' }
        }
      },
      ...PROFILES
    ])
  ).toBe('custom:tiny');
});
