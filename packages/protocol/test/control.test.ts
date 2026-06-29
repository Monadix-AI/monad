import { expect, test } from 'bun:test';

import {
  branchSessionRequestSchema,
  createSessionRequestSchema,
  MESSAGE_TEXT_MAX,
  providerViewSchema,
  SEARCH_QUERY_MAX,
  SESSION_TITLE_MAX,
  sendMessageRequestSchema,
  updateSessionRequestSchema
} from '../src/control.ts';
import { RPC_METHOD_PARAMS } from '../src/rpc-methods.ts';

// The built-in provider catalog now lives in @monad/atoms (the first-party providers own their
// descriptors); its coverage/invariants are tested there — see packages/atoms/test/providers.test.ts.

test('createSession title: accepts up to the cap, rejects beyond it', () => {
  expect(createSessionRequestSchema.safeParse({ title: 'x'.repeat(SESSION_TITLE_MAX) }).success).toBe(true);
  expect(createSessionRequestSchema.safeParse({ title: 'x'.repeat(SESSION_TITLE_MAX + 1) }).success).toBe(false);
});

test('sendMessage text: accepts up to the cap, rejects beyond it (DoS guard)', () => {
  expect(sendMessageRequestSchema.safeParse({ text: 'x'.repeat(MESSAGE_TEXT_MAX) }).success).toBe(true);
  expect(sendMessageRequestSchema.safeParse({ text: 'x'.repeat(MESSAGE_TEXT_MAX + 1) }).success).toBe(false);
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
