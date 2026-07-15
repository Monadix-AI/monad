import { expect, test } from 'bun:test';

import {
  interactionCancelBodySchema,
  interactionClaimBodySchema,
  interactionEventSchema,
  interactionIdParamsSchema,
  interactionLeaseBodySchema,
  interactionPresenterCapabilitiesSchema,
  interactionPresenterParamsSchema,
  interactionRequestSchema,
  interactionResultSchema,
  interactionSubmitBodySchema,
  pendingInteractionSchema
} from '../src/interaction.ts';

test('accepts bounded confirm, select, and form requests', () => {
  expect(interactionRequestSchema.parse({ type: 'confirm', title: 'Continue?' }).type).toBe('confirm');
  expect(
    interactionRequestSchema.parse({
      type: 'select',
      title: 'Region',
      options: [{ value: 'us', label: 'US' }]
    }).type
  ).toBe('select');
  expect(
    interactionRequestSchema.parse({
      type: 'form',
      title: 'Configure',
      fields: [
        { id: 'key', type: 'secret', label: 'API key', required: true },
        { id: 'count', type: 'number', label: 'Count', min: 1, max: 8 }
      ]
    }).type
  ).toBe('form');
});

test('rejects unsupported fields and oversized schemas', () => {
  expect(() =>
    interactionRequestSchema.parse({
      type: 'form',
      title: 'Bad',
      fields: [{ id: 'x', type: 'html', label: 'HTML', render: () => null }]
    })
  ).toThrow();
  expect(() =>
    interactionRequestSchema.parse({
      type: 'form',
      title: 'Too many',
      fields: Array.from({ length: 33 }, (_, index) => ({ id: `f${index}`, type: 'string', label: 'Field' }))
    })
  ).toThrow();
});

test('models presenter capabilities, pending attribution, and exactly typed outcomes', () => {
  expect(
    interactionPresenterCapabilitiesSchema.parse({
      interactionTypes: ['confirm', 'form'],
      fieldTypes: ['string', 'secret'],
      supportsSecretInput: true,
      supportsBackgroundQueue: false
    }).supportsSecretInput
  ).toBe(true);
  const pending = pendingInteractionSchema.parse({
    id: 'int_123',
    source: { kind: 'atom-pack', packId: 'vendor', atomId: 'cloud' },
    request: { type: 'confirm', title: 'Continue?' },
    mode: 'background',
    state: 'pending',
    createdAt: '2026-07-13T00:00:00.000Z',
    expiresAt: '2026-07-13T00:01:00.000Z'
  });
  expect(pending.source.kind).toBe('atom-pack');
  if (pending.source.kind === 'atom-pack') expect(pending.source.packId).toBe('vendor');
  expect(interactionResultSchema.parse({ status: 'submitted', values: { ok: true } }).status).toBe('submitted');
  expect(interactionResultSchema.parse({ status: 'cancelled', reason: 'timeout' }).status).toBe('cancelled');
});

test('models redacted lifecycle events without submitted values', () => {
  const upsert = interactionEventSchema.parse({
    type: 'upsert',
    interaction: {
      id: 'int_123',
      source: { kind: 'builtin', id: 'settings' },
      request: { type: 'confirm', title: 'Continue?' },
      mode: 'foreground',
      state: 'pending',
      createdAt: '2026-07-13T00:00:00.000Z',
      expiresAt: '2026-07-13T00:01:00.000Z'
    }
  });
  expect(upsert.type).toBe('upsert');
  expect(interactionEventSchema.parse({ type: 'removed', id: 'int_123', outcome: 'submitted' })).toEqual({
    type: 'removed',
    id: 'int_123',
    outcome: 'submitted'
  });
  expect(() =>
    interactionEventSchema.parse({
      type: 'removed',
      id: 'int_123',
      outcome: 'submitted',
      values: { apiKey: 'secret-value' }
    })
  ).toThrow();
});

test('validates interaction HTTP parameters and request bodies from protocol schemas', () => {
  expect(interactionIdParamsSchema.parse({ id: 'int_123' })).toEqual({ id: 'int_123' });
  expect(interactionPresenterParamsSchema.parse({ presenterId: 'web' })).toEqual({ presenterId: 'web' });
  expect(
    interactionClaimBodySchema.parse({
      presenterId: 'web',
      capabilities: {
        interactionTypes: ['confirm'],
        fieldTypes: ['string'],
        supportsSecretInput: false,
        supportsBackgroundQueue: true
      }
    })
  ).toEqual({
    presenterId: 'web',
    capabilities: {
      interactionTypes: ['confirm'],
      fieldTypes: ['string'],
      supportsSecretInput: false,
      supportsBackgroundQueue: true
    }
  });
  expect(interactionLeaseBodySchema.parse({ leaseToken: 'lease_123' })).toEqual({ leaseToken: 'lease_123' });
  expect(interactionSubmitBodySchema.parse({ leaseToken: 'lease_123', values: { approved: true } })).toEqual({
    leaseToken: 'lease_123',
    values: { approved: true }
  });
  expect(interactionCancelBodySchema.parse({ leaseToken: 'lease_123', reason: 'escape' })).toEqual({
    leaseToken: 'lease_123',
    reason: 'escape'
  });
});

test('rejects malformed interaction HTTP parameters and request bodies', () => {
  expect(() => interactionIdParamsSchema.parse({ id: '' })).toThrow();
  expect(() => interactionPresenterParamsSchema.parse({ presenterId: '' })).toThrow();
  expect(() => interactionLeaseBodySchema.parse({ leaseToken: '' })).toThrow();
  expect(() => interactionSubmitBodySchema.parse({ leaseToken: 'lease_123', values: {}, extra: true })).toThrow();
  expect(() => interactionCancelBodySchema.parse({ leaseToken: 'lease_123', reason: 'unknown' })).toThrow();
});
