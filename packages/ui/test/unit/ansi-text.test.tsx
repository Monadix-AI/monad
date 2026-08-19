import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { AnsiText, hasAnsiSgr, parseAnsiText } from '../../src/components/AnsiText.tsx';

test('ANSI SGR sequences render as text instead of visible control characters', () => {
  const input =
    '\u001b[90m2026-08-19T11:23:25.205+08:00\u001b[39m \u001b[36m[gateway]\u001b[39m loading configuration…';
  const html = renderToStaticMarkup(<AnsiText segments={parseAnsiText(input)} />);

  expect(html.replace(/<[^>]+>/g, '')).toBe('2026-08-19T11:23:25.205+08:00 [gateway] loading configuration…');
  expect(html.includes('\u001b')).toBe(false);
  expect(hasAnsiSgr(input)).toBe(true);
});

test('ANSI reset codes preserve every surrounding text span', () => {
  const input = 'base \u001b[1;31merror\u001b[0m done';
  const html = renderToStaticMarkup(<AnsiText segments={parseAnsiText(input, 'terminal-output')} />);

  expect(html.replace(/<[^>]+>/g, '')).toBe('base error done');
});
