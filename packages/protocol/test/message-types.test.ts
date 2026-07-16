import { expect, test } from 'bun:test';
import { z } from 'zod';

import {
  includeInContext,
  isHttpUrl,
  pickRepresentation,
  registerMessageType,
  resolveMessageType,
  sessionSchema,
  unregisterMessageType,
  validateMessageData
} from '../src/index.ts';

test('session contract has no branch lineage fields', () => {
  expect('parentSessionId' in sessionSchema.shape).toBe(false);
  expect('branchedAtMessageId' in sessionSchema.shape).toBe(false);
});

test('isHttpUrl accepts only http(s) — the shared scheme allowlist for card actions + render boundaries', () => {
  expect(isHttpUrl('https://x.dev')).toBe(true);
  expect(isHttpUrl('http://x.dev/path?q=1')).toBe(true);
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'vbscript:x', 'file:///etc/passwd', 'not-a-url', '']) {
    expect(isHttpUrl(bad)).toBe(false);
  }
});

test('built-in context defaults reproduce the historical implicit rules', () => {
  expect(includeInContext({ type: 'text' })).toBe(true);
  expect(includeInContext({ type: 'markdown' })).toBe(true);
  expect(includeInContext({ type: 'tool_call' })).toBe(true);
  expect(includeInContext({ type: 'tool_result' })).toBe(true);
  expect(includeInContext({ type: 'error' })).toBe(false);
  expect(includeInContext({ type: 'directive' })).toBe(false);
});

test('per-message override wins over the type default', () => {
  expect(includeInContext({ type: 'error', includeInContext: true })).toBe(true);
  expect(includeInContext({ type: 'text', includeInContext: false })).toBe(false);
});

test('unknown types fall back to the pass-through descriptor (in context via text)', () => {
  expect(includeInContext({ type: 'something_custom' })).toBe(true);
  expect(resolveMessageType('something_custom').fallbacks).toEqual(['markdown', 'text']);
});

test('branch source messages are UI-only snapshot boundaries with a title', () => {
  const descriptor = resolveMessageType('branch_source');
  expect(descriptor.includeInContext).toBe(false);
  expect(descriptor.interactions).toBeUndefined();
  expect(
    descriptor.dataSchema.parse({
      sessionTitle: 'Original session',
      sessionId: 'ses_123456789012',
      messageId: 'msg_123456789012'
    })
  ).toEqual({ sessionTitle: 'Original session' });
});

test('atom types are namespaced and cannot shadow built-ins', () => {
  const d = registerMessageType('myatompack', {
    type: 'card',
    dataSchema: z.unknown(),
    fallbacks: ['data', 'markdown', 'text'],
    interactions: ['buttons'],
    includeInContext: false
  });
  expect(d.type).toBe('myatompack:card');
  expect(resolveMessageType('myatompack:card').includeInContext).toBe(false);
  expect(includeInContext({ type: 'myatompack:card' })).toBe(false);

  // Registering the same namespaced type twice throws (no silent clobber).
  expect(() =>
    registerMessageType('myatompack', {
      type: 'card',
      dataSchema: z.unknown(),
      fallbacks: ['text'],
      includeInContext: true
    })
  ).toThrow();
  unregisterMessageType('myatompack:card');
  // After unregister it degrades to the unknown descriptor again.
  expect(resolveMessageType('myatompack:card')).toBe(resolveMessageType('totally_unknown'));
});

test('pickRepresentation walks the degradation chain by capability', () => {
  registerMessageType('myatompack', {
    type: 'card',
    dataSchema: z.unknown(),
    fallbacks: ['data', 'markdown', 'text'],
    interactions: ['buttons', 'links'],
    includeInContext: true
  });
  const type = 'myatompack:card';

  const rich = { richTypes: new Set([type]), markdown: true, interactions: new Set(['buttons', 'links'] as const) };
  expect(pickRepresentation(type, rich)).toBe('data');

  // Has the renderer but is missing an interaction → skip 'data', take 'markdown'.
  expect(pickRepresentation(type, { richTypes: new Set([type]), markdown: true, interactions: new Set() })).toBe(
    'markdown'
  );
  // Markdown-only client (e.g. a thin channel adapter) → markdown.
  expect(pickRepresentation(type, { markdown: true })).toBe('markdown');
  // No capabilities at all → guaranteed text fallback.
  expect(pickRepresentation(type, {})).toBe('text');
  // A plain text type is always text regardless of client richness.
  expect(pickRepresentation('text', rich)).toBe('text');

  unregisterMessageType(type);
});

test('validateMessageData enforces the card schema and passes opaque/unknown types', () => {
  const good = validateMessageData('card', { title: 'Hi', actions: [{ label: 'Open', url: 'https://x.dev' }] });
  expect(good.ok).toBe(true);
  // Bad action url + empty label → rejected.
  const bad = validateMessageData('card', { actions: [{ label: '', url: 'not-a-url' }] });
  expect(bad.ok).toBe(false);
  // Opaque built-in and unknown types accept anything (z.unknown()).
  expect(validateMessageData('text', { anything: true }).ok).toBe(true);
  expect(validateMessageData('mystery_type', { x: 1 }).ok).toBe(true);
});

test('card action url rejects javascript:/data: schemes (XSS guard)', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)']) {
    expect(validateMessageData('card', { actions: [{ label: 'Click', url }] }).ok).toBe(false);
  }
  // http(s) still accepted.
  expect(validateMessageData('card', { actions: [{ label: 'ok', url: 'http://x.dev' }] }).ok).toBe(true);
  expect(validateMessageData('card', { actions: [{ label: 'ok', url: 'https://x.dev' }] }).ok).toBe(true);
});

test('tool_call/tool_result degrade to text via the registry (web renders them via a separate path)', () => {
  const rich = { richTypes: new Set(['tool_call', 'tool_result']), markdown: true };
  expect(pickRepresentation('tool_call', rich)).toBe('text');
  expect(pickRepresentation('tool_result', rich)).toBe('text');
});
