import type { MonadConfig } from '@monad/home';

import { expect, test } from 'bun:test';
import { createDefaultConfig } from '@monad/home';

import { resolveAgentModelRole, resolveModelRole } from '#/config/resolve.ts';

function model(over: Partial<MonadConfig['model']> = {}): MonadConfig['model'] {
  return {
    default: '',
    providers: [],
    profiles: [{ alias: 'default', routes: { chat: { provider: 'p', modelId: 'm' } }, params: {}, fallbacks: [] }],
    roles: {},
    tierOverrides: {},
    kinds: {},
    ...over
  };
}

test('chat resolves to the default profile alias', () => {
  expect(resolveModelRole(model(), 'chat')).toBe('default');
});

test('chat resolves to the configured default profile alias when set', () => {
  expect(
    resolveModelRole(
      model({
        default: 'review',
        profiles: [
          { alias: 'default', routes: { chat: { provider: 'p', modelId: 'm' } }, params: {}, fallbacks: [] },
          {
            alias: 'review',
            routes: { chat: { provider: 'p', modelId: 'review-model' } },
            params: {},
            fallbacks: []
          }
        ]
      }),
      'chat'
    )
  ).toBe('review');
});

test('vision falls back to the chat default when unassigned', () => {
  expect(resolveModelRole(model(), 'vision')).toBe('default');
  expect(
    resolveModelRole(
      model({
        profiles: [
          {
            alias: 'default',
            routes: {
              chat: { provider: 'p', modelId: 'm' },
              vision: { provider: 'openai', modelId: 'gpt-5-vision' }
            },
            params: {},
            fallbacks: []
          }
        ]
      }),
      'vision'
    )
  ).toBe('openai:gpt-5-vision');
});

test('vision requires an explicit role model when default model capabilities are unknown', () => {
  expect(() => resolveModelRole(model(), 'vision', undefined, () => undefined)).toThrow(
    /cannot determine capabilities.*set the role model explicitly/
  );
});

test('default profile role assignments are used instead of legacy global role assignments', () => {
  expect(
    resolveModelRole(
      model({
        roles: { vision: 'legacy:gpt-vision' },
        profiles: [
          {
            alias: 'default',
            routes: {
              chat: { provider: 'p', modelId: 'm' },
              vision: { provider: 'profile', modelId: 'gpt-vision' }
            },
            params: {},
            fallbacks: []
          }
        ]
      }),
      'vision'
    )
  ).toBe('profile:gpt-vision');
});

test('role resolution can target a non-default profile alias', () => {
  expect(
    resolveModelRole(
      model({
        profiles: [
          {
            alias: 'review',
            routes: {
              chat: { provider: 'p', modelId: 'm' },
              image: { provider: 'profile', modelId: 'image' }
            },
            params: {},
            fallbacks: []
          }
        ]
      }),
      'image',
      'review'
    )
  ).toBe('profile:image');
});

test('image/speech resolve from their role assignments', () => {
  expect(
    resolveModelRole(
      model({
        profiles: [
          {
            alias: 'default',
            routes: {
              chat: { provider: 'p', modelId: 'm' },
              image: { provider: 'new', modelId: 'img' },
              speech: { provider: 'new', modelId: 'tts' }
            },
            params: {},
            fallbacks: []
          }
        ]
      }),
      'image'
    )
  ).toBe('new:img');
  expect(
    resolveModelRole(
      model({
        profiles: [
          {
            alias: 'default',
            routes: {
              chat: { provider: 'p', modelId: 'm' },
              image: { provider: 'new', modelId: 'img' },
              speech: { provider: 'new', modelId: 'tts' }
            },
            params: {},
            fallbacks: []
          }
        ]
      }),
      'speech'
    )
  ).toBe('new:tts');
});

test('embedding has no fallback — undefined until assigned (so semantic search degrades to keyword)', () => {
  expect(
    resolveModelRole(
      model({
        profiles: [
          {
            alias: 'default',
            routes: {
              chat: { provider: 'p', modelId: 'm' },
              embedding: { provider: 'openai', modelId: 'text-embedding-3-large' }
            },
            params: {},
            fallbacks: []
          }
        ]
      }),
      'embedding'
    )
  ).toBe('openai:text-embedding-3-large');
});

test('memory role falls back to the chat default until assigned', () => {
  expect(resolveModelRole(model(), 'memory')).toBe('default');
  expect(
    resolveModelRole(
      model({
        profiles: [
          {
            alias: 'default',
            routes: {
              chat: { provider: 'p', modelId: 'm' },
              memory: { provider: 'oa', modelId: 'gpt-5-mini' }
            },
            params: {},
            fallbacks: []
          }
        ]
      }),
      'memory'
    )
  ).toBe('oa:gpt-5-mini');
});

test('fast role falls back to the chat default until assigned', () => {
  expect(resolveModelRole(model(), 'fast')).toBe('default');
  expect(
    resolveModelRole(
      model({
        profiles: [
          {
            alias: 'default',
            routes: {
              chat: { provider: 'p', modelId: 'm' },
              fast: { provider: 'oa', modelId: 'gpt-5-mini' }
            },
            params: {},
            fallbacks: []
          }
        ]
      }),
      'fast'
    )
  ).toBe('oa:gpt-5-mini');
});

test('resolveAgentModelRole: per-agent override > profile role > fallback', () => {
  const m = model({
    profiles: [
      {
        alias: 'default',
        routes: {
          chat: { provider: 'p', modelId: 'm' },
          memory: { provider: 'profile', modelId: 'cheap' },
          embedding: { provider: 'profile', modelId: 'emb' }
        },
        params: {},
        fallbacks: []
      }
    ]
  });
  expect(resolveAgentModelRole(m, undefined, 'memory')).toBe('profile:cheap');
  // agent override wins
  expect(resolveAgentModelRole(m, { memory: 'agent:tiny' }, 'memory')).toBe('agent:tiny');
  // unset agent role inherits the profile one
  expect(resolveAgentModelRole(m, { vision: 'agent:v' }, 'embedding')).toBe('profile:emb');
  // chat is never overridden per-role (it's the agent's modelAlias path, not roles)
  expect(resolveAgentModelRole(m, { memory: 'x' }, 'chat')).toBe('default');
});

test('the default config carries an empty manual model-kind override map', () => {
  // The override layer ("providerId:modelId" → kind) starts empty; operators opt in via config.
  expect(createDefaultConfig('prn_x', 'x').model.kinds).toEqual({});
});
