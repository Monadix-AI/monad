// mem0 model resolution: picks LLM + embedder from Monad's model registry (profiles/providers/
// credentials), maps provider types → mem0 providers, derives embedding dimension, and errors when
// a selection is unresolvable or can't embed. No environment variables.

import type { MonadAuth, MonadConfig } from '@monad/home';

import { expect, test } from 'bun:test';

import { resolveMem0Models } from '#/services/memory/resolve-mem0.ts';

const cfg = {
  model: {
    default: '',
    providers: [
      { id: 'oa', type: 'openai', label: 'OpenAI' },
      { id: 'ol', type: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1' },
      { id: 'an', type: 'anthropic', label: 'Anthropic' }
    ],
    profiles: [
      {
        alias: 'default',
        routes: {
          chat: { provider: 'oa', modelId: 'gpt-4o-mini' },
          embedding: { provider: 'oa', modelId: 'text-embedding-3-small' }
        },
        params: {},
        fallbacks: []
      },
      { alias: 'claude', routes: { chat: { provider: 'an', modelId: 'claude-x' } }, params: {}, fallbacks: [] }
    ],
    roles: {}
  }
} as unknown as MonadConfig;

const auth = { credentialPool: { oa: [{ id: 'c1', accessToken: 'sk-oa' }] } } as unknown as MonadAuth;

test('defaults: LLM←default profile, embedder←default profile embedding role, with credential + dim', () => {
  const r = resolveMem0Models(cfg, auth, {});
  expect(r.models?.llm).toEqual({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-oa', baseUrl: undefined });
  expect(r.models?.embedder.provider).toBe('openai');
  expect(r.models?.embedder.model).toBe('text-embedding-3-small');
  expect(r.models?.dim).toBe(1536);
});

test('explicit local Ollama embedder: provider ollama, baseUrl + 768 dim', () => {
  const r = resolveMem0Models(cfg, auth, { embedder: 'ol:nomic-embed-text' });
  expect(r.models?.embedder).toMatchObject({
    provider: 'ollama',
    model: 'nomic-embed-text',
    baseUrl: 'http://localhost:11434/v1'
  });
  expect(r.models?.dim).toBe(768);
});

test('embedDim override wins over auto-detection', () => {
  const r = resolveMem0Models(cfg, auth, { embedDim: 1024 });
  expect(r.models?.dim).toBe(1024);
});

test('anthropic embedder is rejected (can not produce embeddings)', () => {
  const r = resolveMem0Models(cfg, auth, { embedder: 'claude' });
  expect(r.error).toContain("can't produce embeddings");
});

test('unknown model reference errors', () => {
  const r = resolveMem0Models(cfg, auth, { llm: 'nope' });
  expect(r.error).toContain('LLM');
});

test('no embedding configured errors', () => {
  const noEmb = {
    model: {
      ...cfg.model,
      profiles: cfg.model.profiles.map((profile) =>
        profile.alias === 'default' ? { ...profile, routes: { chat: profile.routes.chat }, roles: {} } : profile
      )
    }
  } as unknown as MonadConfig;
  const r = resolveMem0Models(noEmb, auth, {});
  expect(r.error).toContain('no embedding model selected');
});

test('openrouter LLM maps to openai provider with default base URL', () => {
  const orCfg = {
    model: {
      ...cfg.model,
      providers: [...cfg.model.providers, { id: 'or', type: 'openrouter', label: 'OpenRouter' }],
      profiles: [
        ...cfg.model.profiles,
        {
          alias: 'or-chat',
          routes: { chat: { provider: 'or', modelId: 'anthropic/claude-sonnet-4-6' } },
          params: {},
          fallbacks: []
        }
      ]
    }
  } as unknown as MonadConfig;
  const orAuth = {
    credentialPool: { or: [{ id: 'c2', accessToken: 'sk-or' }] }
  } as unknown as MonadAuth;
  const r = resolveMem0Models(orCfg, orAuth, { llm: 'or-chat', embedder: 'oa:text-embedding-3-small' });
  expect(r.models?.llm).toEqual({
    provider: 'openai',
    model: 'anthropic/claude-sonnet-4-6',
    apiKey: 'sk-or',
    baseUrl: 'https://openrouter.ai/api/v1'
  });
});
