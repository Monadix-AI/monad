import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { FaviconLink, faviconHref, hideFailedFavicon } from '../../src/components/FaviconLink.tsx';

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

test('FaviconLink renders a decorative favicon before the original link label', () => {
  const markup = renderToStaticMarkup(createElement(FaviconLink, { href: 'https://example.com/docs' }, 'Example docs'));

  expect(markup).toContain('src="https://example.com/favicon.ico"');
  expect(markup).toContain('aria-hidden="true"');
  expect(markup).toContain('href="https://example.com/docs"');
  expect(markup).toContain('rel="noopener noreferrer"');
  expect(markup.indexOf('<img')).toBeLessThan(markup.indexOf('Example docs'));
});

test('FaviconLink centers the favicon and text in one inline row', () => {
  const markup = renderToStaticMarkup(
    createElement(FaviconLink, { href: 'https://github.com/org/repo' }, 'Hermes channel_prompts PR #10564')
  );

  expect(markup).toContain('inline-flex');
  expect(markup).toContain('items-center');
  expect(markup).not.toContain('align-[-2px]');
});

test('FaviconLink keeps the pointer cursor when the global interactive cursor is disabled', () => {
  const markup = renderToStaticMarkup(createElement(FaviconLink, { href: 'https://example.com/docs' }, 'Example docs'));

  expect(markup).toContain('cursor-pointer');
  expect(markup).toContain('data-preserve-cursor="true"');
});

test('failed favicons are removed from layout', () => {
  const target = { hidden: false };

  hideFailedFavicon(target);

  expect(target).toEqual({ hidden: true });
});
