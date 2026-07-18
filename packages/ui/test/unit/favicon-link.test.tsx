import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
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

test('FaviconLink aligns the favicon and text to the surrounding text baseline', () => {
  const markup = renderToStaticMarkup(
    createElement(FaviconLink, { href: 'https://github.com/org/repo' }, 'Hermes channel_prompts PR #10564')
  );

  expect(markup).toContain('inline-flex');
  expect(markup).toContain('items-baseline');
  expect(markup).toContain('align-baseline');
  expect(markup).toContain('leading-[inherit]');
  expect(markup).toContain('data-inline-link="web"');
});

test('FaviconLink keeps a fixed fallback icon when no favicon is available', () => {
  const markup = renderToStaticMarkup(createElement(FaviconLink, { href: 'mailto:team@example.com' }, 'Email team'));

  expect(markup).toContain('data-favicon-fallback="true"');
  expect(markup).toContain('size-3.5');
  expect(markup).toContain('<svg');
  expect(markup).not.toContain('<img');
});

test('inline favicons are excluded from Markdown body image spacing', () => {
  const markup = renderToStaticMarkup(createElement(FaviconLink, { href: 'https://example.com/docs' }, 'Example docs'));
  const markdownRenderer = readFileSync(new URL('../../src/components/MarkdownRenderer.tsx', import.meta.url), 'utf8');

  expect(markup).toContain('data-inline-favicon="true"');
  expect(markdownRenderer).toContain('_img:not([data-inline-favicon])');
});

test('FaviconLink keeps the pointer cursor when the global interactive cursor is disabled', () => {
  const markup = renderToStaticMarkup(createElement(FaviconLink, { href: 'https://example.com/docs' }, 'Example docs'));

  expect(markup).toContain('cursor-pointer');
  expect(markup).toContain('data-preserve-cursor="true"');
});

test('failed favicon images are hidden to reveal the fallback icon', () => {
  const target = { hidden: false };

  hideFailedFavicon(target);

  expect(target).toEqual({ hidden: true });
});
