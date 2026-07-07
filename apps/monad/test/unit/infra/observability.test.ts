import { expect, test } from 'bun:test';

import { resolveObservabilityEndpoint } from '@/infra/observability.ts';

test('resolveObservabilityEndpoint keeps an explicit endpoint', () => {
  expect(resolveObservabilityEndpoint({ endpoint: 'http://collector.local:4318', developerMode: true })).toBe(
    'http://collector.local:4318'
  );
});

test('resolveObservabilityEndpoint enables local OTel export in Developer Mode', () => {
  expect(resolveObservabilityEndpoint({ endpoint: '', developerMode: true })).toBe('http://localhost:6006');
});

test('resolveObservabilityEndpoint stays disabled when Developer Mode is off', () => {
  expect(resolveObservabilityEndpoint({ endpoint: '', developerMode: false })).toBe('');
});
