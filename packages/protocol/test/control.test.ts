import { expect, test } from 'bun:test';

import { agentMemorySettingsSchema, agentSchema, agentSkillsSchema } from '../src/domain.ts';
import { memoryStatusResponseSchema, optionalMemoryScopeQuerySchema } from '../src/memory.ts';
import {
  branchSessionRequestSchema,
  createAgentRequestSchema,
  createSessionRequestSchema,
  getInitStatusResponseSchema,
  listSessionsQuerySchema,
  MESSAGE_ATTACHMENT_DATA_MAX,
  MESSAGE_TEXT_MAX,
  providerViewSchema,
  SEARCH_QUERY_MAX,
  SESSION_TITLE_MAX,
  sendMessageRequestSchema,
  updateSessionRequestSchema
} from '../src/rpc/control.ts';
import { clarifyRespondRequestSchema } from '../src/rpc/interaction-control.ts';
import { RPC_METHOD_PARAMS } from '../src/rpc/rpc-methods.ts';

// The built-in provider catalog now lives in @monad/atoms (the first-party providers own their
// descriptors); its coverage/invariants are tested there — see packages/atoms/test/providers.test.ts.

test('agent skills default to inherited workspace settings', () => {
  expect(agentSkillsSchema.parse({})).toEqual({
    mode: 'inherit',
    allow: [],
    disabled: []
  });
});

test('agent memory is required while new agents default automatic consolidation off', () => {
  expect(
    agentMemorySettingsSchema.parse({
      enabled: false,
      advanced: true,
      autoConsolidate: true,
      intervalMinutes: 45
    })
  ).toEqual({
    enabled: false,
    advanced: true,
    autoConsolidate: true,
    intervalMinutes: 45
  });
  expect(() =>
    agentSchema.parse({
      id: 'agt_000000000001',
      name: 'No memory contract',
      capabilities: [],
      declaredScopes: []
    })
  ).toThrow();
  expect(createAgentRequestSchema.parse({ name: 'New Agent' }).memory).toEqual({
    enabled: true,
    advanced: true,
    autoConsolidate: false,
    intervalMinutes: 30
  });
});

test('global memory contracts expose shared settings without an activation level', () => {
  const status = {
    backend: 'builtin' as const,
    mem0: { llm: null, embedder: null, embedDim: null, ready: false, error: null },
    projects: []
  };
  expect(memoryStatusResponseSchema.strict().parse(status)).toEqual(status);
});

test('clarification responses accept exactly one text answer or URL action', () => {
  expect({
    answer: clarifyRespondRequestSchema.safeParse({ requestId: 'clarify_1', answer: 'yes' }).success,
    complete: clarifyRespondRequestSchema.safeParse({ requestId: 'clarify_2', action: 'complete' }).success,
    empty: clarifyRespondRequestSchema.safeParse({ requestId: 'clarify_3' }).success,
    both: clarifyRespondRequestSchema.safeParse({ requestId: 'clarify_4', answer: 'yes', action: 'cancel' }).success
  }).toEqual({ answer: true, complete: true, empty: false, both: false });
});

test('createSession title: accepts up to the cap, rejects beyond it', () => {
  expect(createSessionRequestSchema.safeParse({ title: 'x'.repeat(SESSION_TITLE_MAX) }).success).toBe(true);
  expect(createSessionRequestSchema.safeParse({ title: 'x'.repeat(SESSION_TITLE_MAX + 1) }).success).toBe(false);
});

test('Agent Session kind requires an Agent scope', () => {
  expect(
    listSessionsQuerySchema.parse({
      agentId: 'agt_000000000001',
      kind: 'monadix',
      limit: 25,
      offset: 0
    })
  ).toEqual({
    agentId: 'agt_000000000001',
    kind: 'monadix',
    limit: 25,
    offset: 0
  });
  expect(listSessionsQuerySchema.safeParse({ kind: 'chat' }).success).toBe(false);
});

test('optional memory scope query accepts a complete pair or neither', () => {
  expect(optionalMemoryScopeQuerySchema.parse({})).toEqual({});
  expect(
    optionalMemoryScopeQuerySchema.parse({
      scopeKind: 'agent',
      scopeId: 'agt_000000000001'
    })
  ).toEqual({ scopeKind: 'agent', scopeId: 'agt_000000000001' });
  expect(optionalMemoryScopeQuerySchema.safeParse({ scopeKind: 'agent' }).success).toBe(false);
  expect(optionalMemoryScopeQuerySchema.safeParse({ scopeId: 'agt_000000000001' }).success).toBe(false);
});

test('sendMessage text: accepts up to the cap, rejects beyond it (DoS guard)', () => {
  expect(sendMessageRequestSchema.safeParse({ text: 'x'.repeat(MESSAGE_TEXT_MAX) }).success).toBe(true);
  expect(sendMessageRequestSchema.safeParse({ text: 'x'.repeat(MESSAGE_TEXT_MAX + 1) }).success).toBe(false);
});

test('sendMessage accepts uploaded binary files and bounds their base64 payload', () => {
  const input = {
    text: 'Inspect this video',
    attachments: [
      {
        kind: 'file' as const,
        name: '2.mp4',
        mediaType: 'video/mp4',
        size: 3,
        dataBase64: 'bXA0'
      }
    ]
  };

  expect(sendMessageRequestSchema.parse(input)).toEqual(input);
  expect(
    sendMessageRequestSchema.safeParse({
      ...input,
      attachments: [{ ...input.attachments[0], dataBase64: 'x'.repeat(MESSAGE_ATTACHMENT_DATA_MAX + 1) }]
    }).success
  ).toBe(false);
});

test('sendMessage preserves assistant-only continuation intent', () => {
  const parsed = sendMessageRequestSchema.parse({ text: '', continueFromHistory: true });
  expect(parsed.continueFromHistory).toBe(true);
});

test('optional title fields are bounded too (update + branch)', () => {
  const tooLong = 'x'.repeat(SESSION_TITLE_MAX + 1);
  expect(updateSessionRequestSchema.safeParse({ title: tooLong }).success).toBe(false);
  expect(branchSessionRequestSchema.safeParse({ title: tooLong }).success).toBe(false);
  // Omitting the optional field stays valid.
  expect(updateSessionRequestSchema.safeParse({}).success).toBe(true);
  expect(branchSessionRequestSchema.safeParse({}).success).toBe(true);
});

test('sessions.search q: bounded against oversized queries', () => {
  const search = RPC_METHOD_PARAMS['sessions.search'];
  expect(search.safeParse({ q: 'x'.repeat(SEARCH_QUERY_MAX) }).success).toBe(true);
  expect(search.safeParse({ q: 'x'.repeat(SEARCH_QUERY_MAX + 1) }).success).toBe(false);
});

test('provider baseUrl accepts only http(s) URLs', () => {
  const provider = { id: 'p', label: 'Provider', type: 'openai-compatible' };
  expect(providerViewSchema.safeParse({ ...provider, baseUrl: 'https://api.example.com/v1' }).success).toBe(true);
  expect(providerViewSchema.safeParse({ ...provider, baseUrl: 'http://localhost:11434/v1' }).success).toBe(true);
  expect(providerViewSchema.safeParse({ ...provider, baseUrl: 'api.example.com/v1' }).success).toBe(false);
  expect(providerViewSchema.safeParse({ ...provider, baseUrl: 'ftp://api.example.com/v1' }).success).toBe(false);
});

test('init status can carry provider credential details alongside legacy missing flags', () => {
  const parsed = getInitStatusResponseSchema.parse({
    initialized: false,
    missing: ['credential'],
    missingProviderCredentials: [
      {
        providerId: 'oai',
        providerLabel: 'OpenAI-compatible',
        profileAlias: 'default',
        route: 'chat'
      }
    ],
    homePath: '/tmp/monad'
  });

  expect(parsed.missingProviderCredentials?.[0]?.providerId).toBe('oai');
});
