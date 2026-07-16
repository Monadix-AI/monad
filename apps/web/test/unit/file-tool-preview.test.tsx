import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { FileReadPreview, UnifiedDiffPreview } from '../../src/features/session/FileToolPreview.tsx';
import { ToolStepView } from '../../src/features/session/ToolStepView.tsx';

test('file read preview renders source line numbers from offset outside selectable code', () => {
  const markup = renderToStaticMarkup(
    createElement(FileReadPreview, {
      offset: 40,
      output: '40\tconst one = 1;\n41\tconst two = 2;\n',
      path: '/workspace/src/value.ts'
    })
  );

  expect(markup).toContain('data-language="typescript"');
  expect(markup).toContain('data-line-number="40"');
  expect(markup).toContain('data-line-number="41"');
  expect(markup).toContain('aria-hidden="true"');
  expect(markup).toContain('select-none');
  expect(markup).toContain('const one = 1;');
  expect(markup).not.toContain('data-line-number="42"');
});

test('unified diff preview renders old and new gutters with semantic row colors', () => {
  const markup = renderToStaticMarkup(
    createElement(UnifiedDiffPreview, {
      display: {
        afterText: 'const current = 2;',
        beforeText: 'const current = 1;',
        diff: '@@ -7,2 +7,2 @@\n const stable = true;\n-const current = 1;\n+const current = 2;',
        path: '/workspace/src/value.ts',
        type: 'diff'
      }
    })
  );

  expect(markup).toContain('data-old-line="7"');
  expect(markup).toContain('data-new-line="7"');
  expect(markup).toContain('data-old-line="8"');
  expect(markup).toContain('data-new-line="8"');
  expect(markup).toContain('bg-red-500/10');
  expect(markup).toContain('bg-emerald-500/10');
  expect(markup).toContain('data-language="typescript"');
  expect(markup).toContain('>+<');
  expect(markup).toContain('>-<');
});

test('file read tool forwards its offset into visible source line numbers', () => {
  const markup = renderToStaticMarkup(
    createElement(ToolStepView, {
      step: {
        id: 'tool_file_read',
        input: { offset: 20, path: '/workspace/src/value.ts' },
        kind: 'tool',
        output: '20\texport const value = 1;\n',
        status: 'running',
        tool: 'file_read'
      }
    })
  );

  expect(markup).toContain('data-line-number="20"');
  expect(markup).toContain('data-language="typescript"');
  expect(markup).toContain('export const value = 1;');
});

test('file diff display uses independent old and new line-number gutters', () => {
  const markup = renderToStaticMarkup(
    createElement(ToolStepView, {
      step: {
        display: {
          afterText: 'const value = 2;',
          beforeText: 'const value = 1;',
          diff: '@@ -4 +4 @@\n-const value = 1;\n+const value = 2;',
          path: '/workspace/src/value.ts',
          type: 'diff'
        },
        id: 'tool_file_diff',
        kind: 'tool',
        status: 'running',
        tool: 'file_edit'
      }
    })
  );

  expect(markup).toContain('data-old-line="4"');
  expect(markup).toContain('data-new-line="4"');
  expect(markup).toContain('bg-red-500/10');
  expect(markup).toContain('bg-emerald-500/10');
});
