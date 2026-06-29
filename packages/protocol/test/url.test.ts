import { expect, test } from 'bun:test';

import { createHttpUrlSchema, httpUrlSchema } from '../src/url.ts';

test('httpUrlSchema accepts both http and https for callers that do not require TLS', () => {
  expect(httpUrlSchema.safeParse('http://localhost:52749').success).toBe(true);
  expect(httpUrlSchema.safeParse('https://api.example.com/v1').success).toBe(true);
});

test('createHttpUrlSchema supports opt-in HTTPS-only validation', () => {
  const httpsOnly = createHttpUrlSchema({ requireHttps: true });

  expect(httpsOnly.safeParse('https://api.example.com/v1').success).toBe(true);
  expect(httpsOnly.safeParse('http://localhost:52749').success).toBe(false);
  expect(httpsOnly.safeParse('javascript:alert(1)').success).toBe(false);
});
