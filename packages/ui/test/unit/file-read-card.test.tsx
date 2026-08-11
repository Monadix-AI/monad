import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  FileReadCard,
  fileReadDisplayContent,
  fileReadShowsGeneratedLineNumbers
} from '../../src/components/FileReadCard.tsx';

test('file read cards generate line numbers only when the provider output omits them', () => {
  expect(
    ['claude-code', 'claude-code-sdk', 'codex', 'gemini'].map((provider) => fileReadShowsGeneratedLineNumbers(provider))
  ).toEqual([false, false, true, true]);
});

test('Claude file read output separates provider line numbers before syntax highlighting', () => {
  expect([
    fileReadDisplayContent(
      "    11→} from '@monad/protocol';\n    12→import type { SessionContext } from '#/session';\n    13→",
      'claude-code'
    ),
    fileReadDisplayContent(
      "11\t} from '@monad/protocol';\n12\timport type { SessionContext } from '#/session';\n13\t\n\n<system-reminder>Provider metadata</system-reminder>",
      'claude-code'
    ),
    fileReadDisplayContent(
      '11\tconst value = 1;\n12\t\n\n<SYSTEM-REMINDER source="provider">first</SYSTEM-REMINDER>\n<system-reminder>second\nline</system-reminder>',
      'claude-code'
    ),
    fileReadDisplayContent('11\tconst value = 1;\nprovider trailing text  ', 'claude-code')
  ]).toEqual([
    {
      code: "} from '@monad/protocol';\nimport type { SessionContext } from '#/session';\n",
      lineNumbers: [11, 12, 13]
    },
    {
      code: "} from '@monad/protocol';\nimport type { SessionContext } from '#/session';\n",
      lineNumbers: [11, 12, 13]
    },
    {
      code: 'const value = 1;\n',
      lineNumbers: [11, 12]
    },
    {
      code: 'const value = 1;\nprovider trailing text  ',
      lineNumbers: [11]
    }
  ]);

  const renderedLineNumbers = (provider: string, content: string) => {
    const markup = renderToStaticMarkup(
      <FileReadCard
        copyCodeLabel="Copy code"
        copyPathLabel="Copy path"
        view={{ content, path: '/workspace/example.ts', provider, type: 'Read' }}
      />
    );
    return {
      generated: /data-generated-line-numbers="(true|false)"/.exec(markup)?.[1],
      provider: [...markup.matchAll(/data-slot="code-block-line-number">(\d+)<\/span>/g)].map((match) => match[1])
    };
  };

  expect([
    renderedLineNumbers('claude-code', '    41→export const value = 1;'),
    renderedLineNumbers('codex', 'export const value = 1;')
  ]).toEqual([
    { generated: 'false', provider: ['41'] },
    { generated: 'true', provider: [] }
  ]);
});
