import { expect, test } from 'bun:test';

import { modelProviderDescriptorSchema } from '../src/rpc/control.ts';
import {
  absoluteUriSchema,
  blankableHttpUrlSchema,
  createHttpUrlSchema,
  httpOriginSchema,
  httpsUrlSchema,
  httpUrlSchema
} from '../src/url.ts';

test('httpUrlSchema accepts both http and https for callers that do not require TLS', () => {
  expect(httpUrlSchema.safeParse('http://localhost:52749').success).toBe(true);
  expect(httpUrlSchema.safeParse('https://api.example.com/v1').success).toBe(true);
});

test('httpUrlSchema parses and normalizes URLs at system boundaries', () => {
  expect(httpUrlSchema.parse('  https://api.example.com/v1  ')).toBe('https://api.example.com/v1');
  expect(httpUrlSchema.safeParse('ftp://api.example.com').success).toBe(false);
  expect(httpUrlSchema.safeParse('javascript:alert(1)').success).toBe(false);
});

test('createHttpUrlSchema supports opt-in HTTPS-only validation', () => {
  const httpsOnly = createHttpUrlSchema({ requireHttps: true });

  expect(httpsOnly.safeParse('https://api.example.com/v1').success).toBe(true);
  expect(httpsOnly.safeParse('http://localhost:52749').success).toBe(false);
  expect(httpsOnly.safeParse('javascript:alert(1)').success).toBe(false);
});

test('httpsUrlSchema rejects plain HTTP for public external links', () => {
  expect(httpsUrlSchema.safeParse('https://example.com/docs').success).toBe(true);
  expect(httpsUrlSchema.safeParse('http://example.com/docs').success).toBe(false);
});

test('httpOriginSchema accepts only http(s) origins', () => {
  expect(httpOriginSchema.parse('  http://localhost:3000  ')).toBe('http://localhost:3000');
  expect(httpOriginSchema.parse('https://example.com')).toBe('https://example.com');
  expect(httpOriginSchema.safeParse('https://example.com/path').success).toBe(false);
  expect(httpOriginSchema.safeParse('ftp://example.com').success).toBe(false);
});

test('blankableHttpUrlSchema preserves empty disabled values and validates non-empty URLs', () => {
  expect(blankableHttpUrlSchema.parse('')).toBe('');
  expect(blankableHttpUrlSchema.parse('  ')).toBe('');
  expect(blankableHttpUrlSchema.parse('http://localhost:6006')).toBe('http://localhost:6006');
  expect(blankableHttpUrlSchema.safeParse('ftp://collector.example.com').success).toBe(false);
});

test('absoluteUriSchema accepts absolute URIs without limiting them to http(s)', () => {
  expect(absoluteUriSchema.parse('https://api.example.com/mcp')).toBe('https://api.example.com/mcp');
  expect(absoluteUriSchema.parse('urn:example:resource')).toBe('urn:example:resource');
  expect(absoluteUriSchema.safeParse('/relative/resource').success).toBe(false);
});

test('model provider descriptors validate default base URLs', () => {
  const descriptor = {
    type: 'openai-compatible',
    label: 'OpenAI Compatible',
    strategy: 'openai-compatible'
  } as const;

  expect(
    modelProviderDescriptorSchema.safeParse({ ...descriptor, defaultBaseUrl: 'http://localhost:11434/v1' }).success
  ).toBe(true);
  expect(
    modelProviderDescriptorSchema.safeParse({ ...descriptor, defaultBaseUrl: 'ftp://api.example.com/v1' }).success
  ).toBe(false);
});
