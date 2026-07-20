import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

import { MessageResponse } from '../../src/components/AIElements';

const sharedMarkdownStyles = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');

function declarationsFor(selector: string): string[] {
  const start = sharedMarkdownStyles.indexOf(`${selector} {`);
  if (start === -1) {
    return [];
  }

  const bodyStart = sharedMarkdownStyles.indexOf('{', start) + 1;
  const bodyEnd = sharedMarkdownStyles.indexOf('}', bodyStart);
  return sharedMarkdownStyles
    .slice(bodyStart, bodyEnd)
    .split(';')
    .map((declaration) => declaration.trim())
    .filter(Boolean);
}

test('MessageResponse uses the shared framed code surface with unobstructed controls', () => {
  const markup = renderToStaticMarkup(<MessageResponse>{'```ts\nconst answer = 42;\n```'}</MessageResponse>);

  const streamdownSlots = [...markup.matchAll(/data-streamdown="([^"]+)"/g)].map((match) => match[1]);
  const responseClassName = /^<div class="([^"]+)"/.exec(markup)?.[1]?.split(' ') ?? [];

  expect({
    codeSlots: streamdownSlots,
    language: /data-language="ts"/.test(markup),
    responseClassName
  }).toEqual({
    codeSlots: [
      'code-block',
      'code-block-header',
      'code-block-actions',
      'code-block-download-button',
      'code-block-copy-button',
      'code-block-body'
    ],
    language: true,
    responseClassName: [
      'space-y-4',
      'whitespace-normal',
      'monad-markdown-content',
      'size-full',
      '[&amp;&gt;*:first-child]:mt-0',
      '[&amp;&gt;*:last-child]:mb-0'
    ]
  });
});

test('shared markdown tables use one framed surface instead of nested cards', () => {
  expect({
    table: declarationsFor('.monad-markdown-content [data-streamdown="table"]'),
    viewport: declarationsFor('.monad-markdown-content [data-streamdown="table-wrapper"] > div:last-child'),
    wrapper: declarationsFor('.monad-markdown-content [data-streamdown="table-wrapper"]')
  }).toEqual({
    table: ['width: 100%', 'margin: 0', 'border-collapse: collapse', 'border: 0'],
    viewport: ['overflow-x: auto', 'overflow-y: hidden', 'background: transparent', 'border: 0', 'border-radius: 0'],
    wrapper: [
      'gap: 0',
      'padding: 0',
      'margin-block: 0.75rem',
      'overflow: hidden',
      'background: color-mix(in srgb, var(--muted) 36%, var(--background))',
      'border: 1px solid var(--border)',
      'border-radius: var(--radius-lg)'
    ]
  });
});
