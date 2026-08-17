import { expect, test } from 'bun:test';

import { faviconHref } from '../../src/components/InlineLink.tsx';

test('faviconHref derives the target origin favicon only for HTTP URLs', () => {
  expect([
    faviconHref('https://docs.example.com/path?q=1'),
    faviconHref('http://example.test:8080/a'),
    faviconHref('mailto:team@example.com'),
    faviconHref('javascript:alert(1)'),
    faviconHref('not a url')
  ]).toEqual([
    'https://docs.example.com/favicon.ico',
    'http://example.test:8080/favicon.ico',
    undefined,
    undefined,
    undefined
  ]);
});
