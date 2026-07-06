import type { ModelCall, ModelChunk, ResolvedProviderConfig } from '@monad/sdk-atom';

import { expect, test } from 'bun:test';
import { KNOWN_PROVIDER_TYPES } from '@monad/protocol';

import { splitSystem } from '../../src/providers/ai-sdk-adapter/index.ts';
import { PROVIDER_DESCRIPTORS } from '../../src/providers/catalog.ts';
import { makeOpenAICompatibleProvider } from '../../src/providers/openai-compatible.ts';
import { builtinModelProviders } from '../../src/providers/registry.ts';

const CRED = { id: 'c1', accessToken: 'key-1', authType: 'api_key' as const, priority: 0 };
const userMsg = [{ role: 'user' as const, content: 'hi' }];

type FetchHandler = (url: string, init: RequestInit | undefined) => Response;
function fakeFetch(handler: FetchHandler): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(url), init))) as unknown as typeof fetch;
}
function sseResponse(deltas: string[]): Response {
  const frames = deltas.map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join('');
  return new Response(`${frames}data: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
}
function jsonResponse(text: string): Response {
  const body = {
    choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
  };
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
}
function call(provider: ResolvedProviderConfig, modelId: string, fetch: typeof globalThis.fetch): ModelCall {
  return { modelId, messages: userMsg, params: {}, provider, credential: CRED, fetch };
}

// ── registry coverage ────────────────────────────────────────────────────────

test('builtin providers cover exactly the known provider types', () => {
  const types = new Set(builtinModelProviders.map((p) => p.type));
  expect(types).toEqual(new Set(KNOWN_PROVIDER_TYPES));
});

test('every builtin provider carries a descriptor and a stream()', () => {
  for (const p of builtinModelProviders) {
    expect(p.descriptor.type).toBe(p.type);
    expect(typeof p.stream).toBe('function');
  }
});

test('Vercel AI Gateway lets the SDK use its default endpoint instead of requiring a base URL', () => {
  const _descriptor = PROVIDER_DESCRIPTORS['vercel-gateway'] as Record<string, unknown>;
});

test('Vercel AI Gateway listModels maps rich /v1/models metadata', async () => {
  const vercel = builtinModelProviders.find((p) => p.type === 'vercel-gateway');
  if (!vercel?.listModels) throw new Error('vercel gateway provider missing');
  let seenAuthorization = '';
  const fetch = fakeFetch((u, init) => {
    expect(u).toBe('https://ai-gateway.vercel.sh/v1/models');
    seenAuthorization = String(new Headers(init?.headers).get('authorization') ?? '');
    return new Response(
      JSON.stringify({
        data: [
          {
            id: 'openai/gpt-4.1',
            name: 'GPT-4.1',
            context_window: 1047576,
            released: 1744588800,
            type: 'language',
            tags: ['file-input', 'implicit-caching', 'tool-use', 'vision'],
            pricing: {
              input: '0.000002',
              output: '0.000008',
              input_cache_read: '0.0000005',
              input_cache_write: '0'
            }
          },
          {
            id: 'alibaba/qwen-3-14b',
            name: 'Qwen3-14B',
            context_window: 40960,
            released: 1745798400,
            type: 'language',
            tags: ['reasoning', 'tool-use'],
            pricing: { input: '0.00000012', output: '0.00000024' }
          },
          {
            id: 'openai/text-embedding-3-large',
            name: 'Text Embedding 3 Large',
            type: 'embedding',
            pricing: { input: '0.00000013' }
          },
          {
            id: 'deepgram/nova-3',
            name: 'Nova 3',
            type: 'transcription'
          },
          {
            id: 'cohere/rerank-v3.5',
            name: 'Rerank v3.5',
            type: 'reranking'
          },
          {
            id: 'alibaba/wan-v2.6-i2v-flash',
            name: 'Wan v2.6 Image-to-Video Flash',
            type: 'video',
            tags: ['vision'],
            pricing: {
              video_duration_pricing: [
                { resolution: '720p', cost_per_second: '0.05' },
                { resolution: '1080p', cost_per_second: '0.075' }
              ]
            }
          },
          {
            id: 'bytedance/seedance-2.0-fast',
            name: 'Seedance 2.0 Fast',
            type: 'video',
            tags: ['vision'],
            pricing: {
              video_token_pricing: {
                no_video_input: { cost_per_million_tokens: '5.6' },
                with_video_input: { cost_per_million_tokens: '3.3' }
              }
            }
          }
        ]
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  });

  const listModels = vercel.listModels as unknown as (
    provider: ResolvedProviderConfig,
    cred: typeof CRED,
    fetch: typeof globalThis.fetch
  ) => Promise<
    Array<{
      id: string;
      label?: string;
      contextLimit?: number;
      releaseDate?: string;
      price?: unknown;
      modalities?: unknown;
    }>
  >;
  const models = await listModels({ id: 'vercel', type: 'vercel-gateway' }, CRED, fetch);

  expect(seenAuthorization).toBe('Bearer key-1');
  expect(models.find((m) => m.id === 'openai/gpt-4.1')).toMatchObject({
    label: 'GPT-4.1',
    contextLimit: 1047576,
    releaseDate: '2025-04-14',
    price: { input: 2, output: 8, cacheRead: 0.5 },
    modalities: {
      kind: 'chat',
      input: ['text', 'image', 'file'],
      output: ['text'],
      toolCall: true
    }
  });
  expect(models.find((m) => m.id === 'alibaba/qwen-3-14b')).toMatchObject({
    contextLimit: 40960,
    releaseDate: '2025-04-28',
    modalities: { kind: 'chat', reasoning: true, toolCall: true }
  });
  expect(models.find((m) => m.id === 'openai/text-embedding-3-large')?.modalities).toMatchObject({
    kind: 'embedding',
    output: ['embeddings']
  });
  expect(models.find((m) => m.id === 'deepgram/nova-3')?.modalities).toMatchObject({
    kind: 'transcription',
    input: ['audio'],
    output: ['transcription']
  });
  expect(models.find((m) => m.id === 'cohere/rerank-v3.5')?.modalities).toMatchObject({
    kind: 'rerank',
    output: ['rerank']
  });
  expect(models.find((m) => m.id === 'alibaba/wan-v2.6-i2v-flash')).toMatchObject({
    label: 'Wan v2.6 Image-to-Video Flash',
    price: {
      videoSecond: 0.05,
      units: [
        { label: '720p', price: 0.05, unit: 'second' },
        { label: '1080p', price: 0.075, unit: 'second' }
      ]
    },
    modalities: {
      kind: 'video',
      input: ['text', 'image'],
      output: ['video']
    }
  });
  expect(models.find((m) => m.id === 'bytedance/seedance-2.0-fast')).toMatchObject({
    price: {
      units: [
        { label: 'With Video Input', price: 3.3, unit: 'M' },
        { label: 'No Video Input', price: 5.6, unit: 'M' }
      ]
    },
    modalities: {
      kind: 'video',
      input: ['text', 'image'],
      output: ['video']
    }
  });
});

test('image/speech are wired only on providers that build those models (openai), not text-only ones', () => {
  const byType = new Map(builtinModelProviders.map((p) => [p.type, p]));
  // openai supplies buildImageModel/buildSpeechModel → defineAiSdkProvider exposes the methods.
  expect(typeof byType.get('openai')?.generateImage).toBe('function');
  expect(typeof byType.get('openai')?.generateSpeech).toBe('function');
  // Gateway-style providers advertise non-text model categories in listModels, so the matching
  // call methods must be present too.
  expect(typeof byType.get('openrouter')?.generateImage).toBe('function');
  expect(typeof byType.get('openrouter')?.generateVideo).toBe('function');
  expect(typeof byType.get('openrouter')?.generateSpeech).toBe('function');
  expect(typeof byType.get('openrouter')?.transcribe).toBe('function');
  expect(typeof byType.get('openrouter')?.rerank).toBe('function');
  expect(typeof byType.get('openrouter')?.embed).toBe('function');
  expect(typeof byType.get('vercel-gateway')?.generateImage).toBe('function');
  expect(typeof byType.get('vercel-gateway')?.embed).toBe('function');
  expect(typeof byType.get('vercel-gateway')?.generateVideo).toBe('function');
  expect(typeof byType.get('vercel-gateway')?.generateSpeech).toBe('function');
  expect(typeof byType.get('vercel-gateway')?.transcribe).toBe('function');
  expect(typeof byType.get('vercel-gateway')?.rerank).toBe('function');
  // text-only providers must NOT advertise them (so the gateway fails over instead of throwing).
});

test('OpenRouter native non-text endpoints map monad calls to REST payloads', async () => {
  const openrouter = builtinModelProviders.find((p) => p.type === 'openrouter');
  if (!openrouter?.generateSpeech || !openrouter.transcribe || !openrouter.rerank || !openrouter.generateVideo) {
    throw new Error('openrouter provider missing native modality methods');
  }
  const seen: Array<{ url: string; body?: unknown }> = [];
  const fetch = fakeFetch((u, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ url: u, body });
    if (u.endsWith('/audio/speech')) {
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'audio/wav' } });
    }
    if (u.endsWith('/audio/transcriptions')) {
      return new Response(JSON.stringify({ text: 'hello', usage: { input_tokens: 2, total_tokens: 2 } }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (u.endsWith('/rerank')) {
      return new Response(
        JSON.stringify({
          results: [
            { index: 1, relevance_score: 0.9 },
            { index: 0, relevance_score: 0.4 }
          ],
          usage: { total_tokens: 7 }
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (u.endsWith('/videos')) {
      return new Response(JSON.stringify({ id: 'job-1', status: 'completed' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (u.endsWith('/videos/job-1/content')) {
      return new Response(new Uint8Array([4, 5]), { headers: { 'Content-Type': 'video/mp4' } });
    }
    return new Response('not found', { status: 404 });
  });
  const provider = { id: 'or', type: 'openrouter' };
  const common = { provider, credential: CRED, fetch };

  const speech = await openrouter.generateSpeech({ ...common, modelId: 'elevenlabs/tts', text: 'hi', voice: 'alloy' });
  const transcript = await openrouter.transcribe({
    ...common,
    modelId: 'openai/whisper',
    audio: new Uint8Array([82, 73, 70, 70]),
    mediaType: 'audio/wav',
    language: 'en'
  });
  const ranking = await openrouter.rerank({
    ...common,
    modelId: 'cohere/rerank',
    query: 'capital',
    documents: ['Berlin', 'Paris'],
    topN: 2
  });
  const video = await openrouter.generateVideo({
    ...common,
    modelId: 'google/veo',
    prompt: 'mountains',
    aspectRatio: '16:9',
    duration: 8,
    resolution: '720p'
  });

  expect(speech).toEqual({ audio: new Uint8Array([1, 2, 3]), mediaType: 'audio/wav' });
  expect(transcript).toMatchObject({ text: 'hello', usage: { inputTokens: 2, totalTokens: 2 } });
  expect(ranking.ranking).toEqual([
    { index: 1, score: 0.9, document: 'Paris' },
    { index: 0, score: 0.4, document: 'Berlin' }
  ]);
  expect(video).toEqual({ video: new Uint8Array([4, 5]), mediaType: 'video/mp4' });
  expect(seen.map((entry) => entry.url)).toEqual([
    'https://openrouter.ai/api/v1/audio/speech',
    'https://openrouter.ai/api/v1/audio/transcriptions',
    'https://openrouter.ai/api/v1/rerank',
    'https://openrouter.ai/api/v1/videos',
    'https://openrouter.ai/api/v1/videos/job-1/content'
  ]);
  expect(seen[0]?.body).toMatchObject({ model: 'elevenlabs/tts', input: 'hi', voice: 'alloy' });
  expect(seen[1]?.body).toMatchObject({
    model: 'openai/whisper',
    input_audio: { data: 'UklGRg==', format: 'wav' },
    language: 'en'
  });
  expect(seen[2]?.body).toMatchObject({
    model: 'cohere/rerank',
    query: 'capital',
    documents: ['Berlin', 'Paris'],
    top_n: 2
  });
  expect(seen[3]?.body).toMatchObject({
    model: 'google/veo',
    prompt: 'mountains',
    aspect_ratio: '16:9',
    duration: 8,
    resolution: '720p'
  });
});

test('OpenRouter listModels rejects invalid credentials even when public models are readable', async () => {
  const openrouter = builtinModelProviders.find((p) => p.type === 'openrouter');
  if (!openrouter?.listModels) throw new Error('openrouter provider missing');

  const fetch = fakeFetch((u) => {
    if (u.endsWith('/api/v1/auth/key')) return new Response('invalid key', { status: 401 });
    return new Response(JSON.stringify({ data: [{ id: 'openai/gpt-test', name: 'GPT Test' }] }), {
      headers: { 'Content-Type': 'application/json' }
    });
  });

  await expect(openrouter.listModels({ id: 'openrouter', type: 'openrouter' }, CRED, fetch)).rejects.toThrow(
    /OpenRouter auth failed: 401/
  );
});

test('OpenRouter listModels does not send credentials to cross-origin model detail links', async () => {
  const openrouter = builtinModelProviders.find((p) => p.type === 'openrouter');
  if (!openrouter?.listModels) throw new Error('openrouter provider missing');
  const seenUrls: string[] = [];
  const seenAuthorizationByUrl = new Map<string, string | null>();

  const fetch = fakeFetch((u, init) => {
    seenUrls.push(u);
    seenAuthorizationByUrl.set(u, new Headers(init?.headers).get('authorization'));
    if (u.endsWith('/api/v1/auth/key')) {
      return new Response(JSON.stringify({ data: {} }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (u === 'https://openrouter.ai/evil/video-model') {
      return new Response('<p>$0.01<span>/second</span></p>', { headers: { 'Content-Type': 'text/html' } });
    }
    if (u.startsWith('https://evil.example/')) {
      return new Response(JSON.stringify({ data: { endpoints: [] } }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(
      JSON.stringify({
        data: [
          {
            id: 'evil/video-model',
            name: 'Evil Video Model',
            architecture: {
              modality: 'text->video',
              input_modalities: ['text'],
              output_modalities: ['video']
            },
            pricing: {
              prompt: '0',
              completion: '0'
            },
            links: {
              details: 'https://evil.example/openrouter-detail'
            }
          }
        ]
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  });

  const models = await openrouter.listModels({ id: 'openrouter', type: 'openrouter' }, CRED, fetch);

  expect(seenUrls.some((u) => u.startsWith('https://evil.example/'))).toBe(false);
  expect(models.find((m) => m.id === 'evil/video-model')).toMatchObject({
    price: {
      videoSecond: 0.01,
      units: [{ label: 'Video', price: 0.01, unit: 'second' }]
    }
  });
});

test('OpenRouter listModels maps provider-native reasoning efforts', async () => {
  const openrouter = builtinModelProviders.find((p) => p.type === 'openrouter');
  if (!openrouter?.listModels) throw new Error('openrouter provider missing');

  const fetch = fakeFetch((u) => {
    if (u.endsWith('/api/v1/auth/key')) {
      return new Response(JSON.stringify({ data: {} }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (u.endsWith('/api/v1/models/black-forest-labs/flux.2-pro/endpoints')) {
      return new Response(
        JSON.stringify({
          data: {
            endpoints: [
              {
                pricing: {
                  prompt: '0',
                  completion: '0',
                  image_output: '0.00000732421875'
                }
              }
            ]
          }
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (u.endsWith('/api/v1/models/bytedance/seedance-2.0-fast-20260414/endpoints')) {
      return new Response(
        JSON.stringify({
          data: {
            endpoints: [
              {
                pricing: {
                  prompt: '0',
                  completion: '0',
                  discount: 0
                }
              }
            ]
          }
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (u.endsWith('/api/v1/models/kwaivgi/kling-video-o1-20260420/endpoints')) {
      return new Response(
        JSON.stringify({
          data: {
            endpoints: [
              {
                pricing: {
                  prompt: '0',
                  completion: '0',
                  discount: 0
                }
              }
            ]
          }
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (u.endsWith('/api/v1/models/cohere/rerank-4-pro/endpoints')) {
      return new Response(
        JSON.stringify({
          data: {
            endpoints: [
              {
                pricing: {
                  prompt: '0',
                  completion: '0',
                  discount: 0
                }
              }
            ]
          }
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (u.endsWith('/api/v1/models/google/chirp-3/endpoints')) {
      return new Response(
        JSON.stringify({
          data: {
            endpoints: [
              {
                pricing: {
                  prompt: '0.016',
                  completion: '0',
                  discount: 0
                }
              }
            ]
          }
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (u.endsWith('/api/v1/models/google/lyria-3-clip-preview-20260330/endpoints')) {
      return new Response(
        JSON.stringify({
          data: {
            endpoints: [
              {
                pricing: {
                  prompt: '0',
                  completion: '0',
                  discount: 0
                }
              }
            ]
          }
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (u.endsWith('/api/v1/models/microsoft/mai-transcribe-1.5/endpoints')) {
      return new Response(
        JSON.stringify({
          data: {
            endpoints: [
              {
                pricing: {
                  prompt: '0.36',
                  completion: '0',
                  discount: 0
                }
              }
            ]
          }
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (u.endsWith('/api/v1/models/qwen/qwen3-asr-flash-2026-02-10/endpoints')) {
      return new Response(
        JSON.stringify({
          data: {
            endpoints: [
              {
                pricing: {
                  prompt: '0.000035',
                  completion: '0',
                  discount: 0
                }
              }
            ]
          }
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (u.endsWith('/bytedance/seedance-2.0-fast')) {
      return new Response(
        '<p class="text-sm font-semibold truncate mt-1">from $0.0538<span class="text-xs">/second</span></p>',
        { headers: { 'Content-Type': 'text/html' } }
      );
    }
    if (u.endsWith('/kwaivgi/kling-video-o1')) {
      return new Response(
        '<p class="text-sm font-semibold truncate mt-1">$0.112<span class="text-xs">/second</span></p>',
        { headers: { 'Content-Type': 'text/html' } }
      );
    }
    if (u.endsWith('/cohere/rerank-4-pro')) {
      return new Response(
        '<p class="text-sm font-semibold truncate mt-1">$0.0025<span class="text-xs">/search</span></p>',
        { headers: { 'Content-Type': 'text/html' } }
      );
    }
    if (u.endsWith('/google/chirp-3')) {
      return new Response(
        '<p class="text-sm font-semibold truncate mt-1">$0.016<span class="text-xs">/minute</span></p>',
        { headers: { 'Content-Type': 'text/html' } }
      );
    }
    if (u.endsWith('/google/lyria-3-clip-preview')) {
      return new Response(
        '<p class="text-sm font-semibold truncate mt-1">$0.04<span class="text-xs">/song</span></p>',
        { headers: { 'Content-Type': 'text/html' } }
      );
    }
    if (u.endsWith('/microsoft/mai-transcribe-1.5')) {
      return new Response(
        '<p class="text-sm font-semibold truncate mt-1">$0.36<span class="text-xs">/hour</span></p>',
        { headers: { 'Content-Type': 'text/html' } }
      );
    }
    if (u.endsWith('/qwen/qwen3-asr-flash-2026-02-10')) {
      return new Response(
        '<p class="text-sm font-semibold truncate mt-1">$0.000035<span class="text-xs">/second</span></p>',
        { headers: { 'Content-Type': 'text/html' } }
      );
    }
    return new Response(
      JSON.stringify({
        data: [
          {
            id: 'sakana/fugu-ultra',
            name: 'Sakana: Fugu Ultra',
            architecture: {
              modality: 'text+image->text',
              input_modalities: ['text', 'image'],
              output_modalities: ['text']
            },
            reasoning: {
              mandatory: true,
              default_enabled: true,
              supported_efforts: ['max', 'xhigh', 'high'],
              default_effort: 'xhigh'
            },
            supported_parameters: ['include_reasoning', 'reasoning', 'tools']
          },
          {
            id: 'openai/gpt-plain',
            name: 'Plain Model',
            architecture: {
              modality: 'text->text',
              input_modalities: ['text'],
              output_modalities: ['text']
            },
            pricing: {
              prompt: '0.000001',
              completion: '0.000002'
            },
            supported_parameters: ['include_reasoning', 'reasoning']
          },
          {
            id: 'alibaba/wan-video',
            name: 'Alibaba: Wan Video',
            architecture: {
              modality: 'text+image->video',
              input_modalities: ['text', 'image'],
              output_modalities: ['video']
            },
            pricing: {
              video_second: '0.08',
              song: '0.02'
            }
          },
          {
            id: 'bytedance/seedance-2.0-fast',
            name: 'ByteDance: Seedance 2.0 Fast',
            created: 1776211362,
            context_length: 0,
            architecture: {
              modality: 'text+image->video',
              input_modalities: ['text', 'image'],
              output_modalities: ['video']
            },
            pricing: {
              prompt: '0',
              completion: '0'
            },
            top_provider: {
              context_length: 0
            },
            supported_parameters: ['frequency_penalty'],
            links: {
              details: '/api/v1/models/bytedance/seedance-2.0-fast-20260414/endpoints'
            }
          },
          {
            id: 'kwaivgi/kling-video-o1',
            name: 'Kling: Video O1',
            created: 1776704777,
            context_length: 0,
            architecture: {
              modality: 'text+image->video',
              input_modalities: ['text', 'image'],
              output_modalities: ['video']
            },
            pricing: {
              prompt: '0',
              completion: '0'
            },
            supported_parameters: ['max_tokens', 'temperature', 'top_p'],
            links: {
              details: '/api/v1/models/kwaivgi/kling-video-o1-20260420/endpoints'
            }
          },
          {
            id: 'cohere/rerank-4-pro',
            name: 'Cohere: Rerank 4 Pro',
            created: 1775446247,
            context_length: 32768,
            architecture: {
              modality: 'text->rerank',
              input_modalities: ['text'],
              output_modalities: ['rerank']
            },
            pricing: {
              prompt: '0',
              completion: '0'
            },
            top_provider: {
              context_length: 32768
            },
            links: {
              details: '/api/v1/models/cohere/rerank-4-pro/endpoints'
            }
          },
          {
            id: 'black-forest-labs/flux.2-pro',
            name: 'Black Forest Labs: FLUX.2 Pro',
            created: 1764030274,
            context_length: 46864,
            architecture: {
              modality: 'text+image->image',
              input_modalities: ['text', 'image'],
              output_modalities: ['image']
            },
            pricing: {
              prompt: '0',
              completion: '0'
            },
            top_provider: {
              context_length: 46864
            },
            supported_parameters: ['seed'],
            links: {
              details: '/api/v1/models/black-forest-labs/flux.2-pro/endpoints'
            }
          },
          {
            id: 'google/chirp-3',
            name: 'Google: Chirp 3',
            architecture: {
              modality: 'audio->transcription',
              input_modalities: ['audio'],
              output_modalities: ['transcription']
            },
            pricing: {
              prompt: '0.016',
              completion: '0'
            },
            links: {
              details: '/api/v1/models/google/chirp-3/endpoints'
            }
          },
          {
            id: 'google/lyria-3-clip-preview',
            name: 'Google: Lyria 3 Clip Preview',
            architecture: {
              modality: 'text+image->text+audio',
              input_modalities: ['text', 'image'],
              output_modalities: ['text', 'audio']
            },
            pricing: {
              prompt: '0',
              completion: '0'
            },
            links: {
              details: '/api/v1/models/google/lyria-3-clip-preview-20260330/endpoints'
            }
          },
          {
            id: 'microsoft/mai-transcribe-1.5',
            name: 'Microsoft: MAI-Transcribe 1.5',
            architecture: {
              modality: 'audio->transcription',
              input_modalities: ['audio'],
              output_modalities: ['transcription']
            },
            pricing: {
              prompt: '0.36',
              completion: '0'
            },
            links: {
              details: '/api/v1/models/microsoft/mai-transcribe-1.5/endpoints'
            }
          },
          {
            id: 'qwen/qwen3-asr-flash-2026-02-10',
            name: 'Qwen: Qwen3 ASR Flash',
            architecture: {
              modality: 'audio->transcription',
              input_modalities: ['audio'],
              output_modalities: ['transcription']
            },
            pricing: {
              prompt: '0.000035',
              completion: '0'
            },
            links: {
              details: '/api/v1/models/qwen/qwen3-asr-flash-2026-02-10/endpoints'
            }
          },
          {
            id: 'openai/embedding-model',
            architecture: {
              modality: 'text->embeddings',
              input_modalities: ['text'],
              output_modalities: ['embeddings']
            }
          },
          {
            id: 'openai/audio-model',
            architecture: {
              modality: 'text->audio',
              input_modalities: ['text'],
              output_modalities: ['audio']
            }
          },
          {
            id: 'openai/tts-model',
            architecture: {
              modality: 'text->speech',
              input_modalities: ['text'],
              output_modalities: ['speech']
            }
          },
          {
            id: 'openai/rerank-model',
            architecture: {
              modality: 'text->rerank',
              input_modalities: ['text'],
              output_modalities: ['rerank']
            }
          },
          {
            id: 'openai/transcribe-model',
            architecture: {
              modality: 'audio->transcription',
              input_modalities: ['audio'],
              output_modalities: ['transcription']
            }
          }
        ]
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  });

  const models = await openrouter.listModels({ id: 'openrouter', type: 'openrouter' }, CRED, fetch);

  expect(models.find((m) => m.id === 'sakana/fugu-ultra')?.modalities).toMatchObject({
    reasoning: true,
    reasoningEfforts: ['max', 'xhigh', 'high'],
    defaultReasoningEffort: 'xhigh'
  });
  expect(models.find((m) => m.id === 'openai/gpt-plain')?.modalities).toMatchObject({
    reasoning: true
  });
  expect(models.find((m) => m.id === 'alibaba/wan-video')).toMatchObject({
    price: {
      videoSecond: 0.08,
      units: [
        { label: 'Video', price: 0.08, unit: 'second' },
        { label: 'Song', price: 0.02, unit: 'song' }
      ]
    },
    modalities: {
      kind: 'video',
      input: ['text', 'image'],
      output: ['video']
    }
  });
  expect(models.find((m) => m.id === 'bytedance/seedance-2.0-fast')).toMatchObject({
    label: 'ByteDance: Seedance 2.0 Fast',
    releaseDate: '2026-04-15',
    price: {
      videoSecond: 0.0538,
      units: [{ label: 'Video', price: 0.0538, unit: 'second' }]
    },
    modalities: {
      kind: 'video',
      input: ['text', 'image'],
      output: ['video']
    }
  });
  expect(models.find((m) => m.id === 'kwaivgi/kling-video-o1')).toMatchObject({
    label: 'Kling: Video O1',
    releaseDate: '2026-04-20',
    price: {
      videoSecond: 0.112,
      units: [{ label: 'Video', price: 0.112, unit: 'second' }]
    },
    modalities: {
      kind: 'video',
      input: ['text', 'image'],
      output: ['video']
    }
  });
  expect(models.find((m) => m.id === 'cohere/rerank-4-pro')).toMatchObject({
    label: 'Cohere: Rerank 4 Pro',
    contextLimit: 32768,
    releaseDate: '2026-04-06',
    detailUrl: 'https://openrouter.ai/cohere/rerank-4-pro',
    price: {
      units: [{ label: 'Search', price: 0.0025, unit: 'search' }]
    },
    modalities: {
      kind: 'rerank',
      input: ['text'],
      output: ['rerank']
    }
  });
  expect(models.find((m) => m.id === 'black-forest-labs/flux.2-pro')).toMatchObject({
    label: 'Black Forest Labs: FLUX.2 Pro',
    contextLimit: 46864,
    releaseDate: '2025-11-25',
    price: {
      units: [{ label: 'Image output', price: 0.03, unit: 'megapixel' }]
    },
    modalities: {
      kind: 'image',
      input: ['text', 'image'],
      output: ['image']
    }
  });
  const chirp = models.find((m) => m.id === 'google/chirp-3');
  expect(chirp).toMatchObject({
    label: 'Google: Chirp 3',
    detailUrl: 'https://openrouter.ai/google/chirp-3',
    price: {
      units: [{ label: 'Audio', price: 0.016, unit: 'minute' }]
    },
    modalities: {
      kind: 'transcription',
      input: ['audio'],
      output: ['transcription']
    }
  });
  const lyria = models.find((m) => m.id === 'google/lyria-3-clip-preview');
  expect(lyria).toMatchObject({
    label: 'Google: Lyria 3 Clip Preview',
    detailUrl: 'https://openrouter.ai/google/lyria-3-clip-preview',
    price: {
      units: [{ label: 'Song', price: 0.04, unit: 'song' }]
    },
    modalities: {
      kind: 'audio',
      input: ['text', 'image'],
      output: ['text', 'audio']
    }
  });
  const maiTranscribe = models.find((m) => m.id === 'microsoft/mai-transcribe-1.5');
  expect(maiTranscribe).toMatchObject({
    label: 'Microsoft: MAI-Transcribe 1.5',
    detailUrl: 'https://openrouter.ai/microsoft/mai-transcribe-1.5',
    price: {
      units: [{ label: 'Audio', price: 0.36, unit: 'hour' }]
    },
    modalities: {
      kind: 'transcription',
      input: ['audio'],
      output: ['transcription']
    }
  });
  const qwenAsr = models.find((m) => m.id === 'qwen/qwen3-asr-flash-2026-02-10');
  expect(qwenAsr).toMatchObject({
    label: 'Qwen: Qwen3 ASR Flash',
    detailUrl: 'https://openrouter.ai/qwen/qwen3-asr-flash-2026-02-10',
    price: {
      videoSecond: 0.000035,
      units: [{ label: 'Video', price: 0.000035, unit: 'second' }]
    },
    modalities: {
      kind: 'transcription',
      input: ['audio'],
      output: ['transcription']
    }
  });
  expect(models.find((m) => m.id === 'openai/embedding-model')?.modalities).toMatchObject({
    kind: 'embedding',
    output: ['embeddings']
  });
  expect(models.find((m) => m.id === 'openai/audio-model')?.modalities).toMatchObject({
    kind: 'audio',
    output: ['audio']
  });
  expect(models.find((m) => m.id === 'openai/tts-model')?.modalities).toMatchObject({
    kind: 'speech',
    output: ['speech']
  });
  expect(models.find((m) => m.id === 'openai/rerank-model')?.modalities).toMatchObject({
    kind: 'rerank',
    output: ['rerank']
  });
  expect(models.find((m) => m.id === 'openai/transcribe-model')?.modalities).toMatchObject({
    kind: 'transcription',
    output: ['transcription']
  });
});

test('Anthropic listModels loads every paged result', async () => {
  const anthropic = builtinModelProviders.find((p) => p.type === 'anthropic');
  if (!anthropic?.listModels) throw new Error('anthropic provider missing');
  const seen: string[] = [];
  const fetch = fakeFetch((u) => {
    seen.push(u);
    const url = new URL(u);
    if (url.searchParams.get('after_id') === 'm1') {
      return new Response(
        JSON.stringify({ data: [{ id: 'm2', display_name: 'Model 2' }], has_more: false, last_id: 'm2' }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response(
      JSON.stringify({ data: [{ id: 'm1', display_name: 'Model 1' }], has_more: true, last_id: 'm1' }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  });

  const models = await anthropic.listModels({ id: 'anthropic', type: 'anthropic' }, CRED, fetch);

  expect(models.map((m) => m.id)).toEqual(['m1', 'm2']);
  expect(seen.map((u) => new URL(u).searchParams.get('after_id'))).toEqual([null, 'm1']);
});

test('Google listModels loads every paged result', async () => {
  const google = builtinModelProviders.find((p) => p.type === 'google');
  if (!google?.listModels) throw new Error('google provider missing');
  const seen: string[] = [];
  const fetch = fakeFetch((u) => {
    seen.push(u);
    const url = new URL(u);
    if (url.searchParams.get('pageToken') === 'next') {
      return new Response(JSON.stringify({ models: [{ name: 'models/gemini-2', displayName: 'Gemini 2' }] }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(
      JSON.stringify({
        models: [{ name: 'models/gemini-1', displayName: 'Gemini 1' }],
        nextPageToken: 'next'
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  });

  const models = await google.listModels({ id: 'google', type: 'google' }, CRED, fetch);

  expect(models.map((m) => m.id)).toEqual(['gemini-1', 'gemini-2']);
  expect(seen.map((u) => new URL(u).searchParams.get('pageToken'))).toEqual([null, 'next']);
});

// ── openai-compatible preset base URL ────────────────────────────────────────

test('an openai-compatible preset targets the catalog default base URL', async () => {
  let seen = '';
  const fetch = fakeFetch((u) => {
    seen = u;
    return sseResponse(['hi']);
  });
  const groq = makeOpenAICompatibleProvider(PROVIDER_DESCRIPTORS.groq);
  if (!groq.stream) throw new Error('groq provider missing stream');
  // No baseUrl on provider/credential — must fall back to the descriptor preset.
  for await (const _ of groq.stream(call({ id: 'groq', type: 'groq' }, 'llama-3.3-70b', fetch))) {
    /* drain */
  }
  const base = PROVIDER_DESCRIPTORS.groq.defaultBaseUrl ?? '';
  expect(seen.startsWith(base)).toBe(true);
});

test('Amazon Bedrock requires a region (extra.region)', async () => {
  const bedrock = builtinModelProviders.find((p) => p.type === 'amazon-bedrock');
  if (!bedrock?.stream) throw new Error('bedrock provider missing stream');
  const stream = bedrock.stream;
  const run = async () => {
    for await (const _ of stream(call({ id: 'bedrock', type: 'amazon-bedrock' }, 'claude', globalThis.fetch))) {
      /* drain */
    }
  };
  await expect(run()).rejects.toThrow(/region/i);
});

// ── stream / complete via the real adapter (fake fetch, no network) ───────────

test('stream() yields one chunk per token delta', async () => {
  const provider = makeOpenAICompatibleProvider(PROVIDER_DESCRIPTORS.groq);
  if (!provider.stream) throw new Error('groq provider missing stream');
  const fetch = fakeFetch(() => sseResponse(['Hel', 'lo']));
  const tokens: string[] = [];
  for await (const chunk of provider.stream(call({ id: 'g', type: 'groq' }, 'm', fetch)) as AsyncIterable<ModelChunk>) {
    if (chunk.type === 'text') tokens.push(chunk.token);
  }
  expect(tokens.join('')).toBe('Hello');
});

test('complete() returns the full text and surfaces provider usage', async () => {
  const provider = makeOpenAICompatibleProvider(PROVIDER_DESCRIPTORS.groq);
  const fetch = fakeFetch(() => jsonResponse('Hello world'));
  const result = await provider.complete?.(call({ id: 'g', type: 'groq' }, 'm', fetch));
  expect(result?.text).toBe('Hello world');
  expect(result?.usage?.inputTokens).toBe(3);
});

// ── splitSystem (model-layer bridge) ─────────────────────────────────────────

test('splitSystem extracts the system to the param by default', () => {
  const { system, messages } = splitSystem([
    { role: 'system', content: 'you are helpful' },
    { role: 'user', content: 'hi' }
  ]);
  expect(system).toBe('you are helpful');
  expect(messages.every((m) => m.role !== 'system')).toBe(true);
});

test('splitSystem with cache emits a leading system message carrying an Anthropic cache breakpoint', () => {
  const { messages } = splitSystem([
    { role: 'system', content: 'static prefix', cache: true },
    { role: 'user', content: 'hi' }
  ]);
  const first = messages[0] as { role: string; providerOptions?: Record<string, unknown> };
  expect(first.role).toBe('system');
  expect(first.providerOptions).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } } });
});

test('splitSystem maps multimodal image parts and passes strings through', () => {
  const { system, messages } = splitSystem([
    { role: 'system', content: 'sys' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'image', image: 'data:x', mediaType: 'image/png' }
      ]
    }
  ]);
  expect(system).toBe('sys');
  expect((messages[0] as { content: unknown }).content).toEqual([
    { type: 'text', text: 'hi' },
    { type: 'image', image: 'data:x', mediaType: 'image/png' }
  ]);
});
