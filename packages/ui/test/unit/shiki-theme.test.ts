import { expect, test } from 'bun:test';
import { createHighlighter } from 'shiki';

import { SHIKI_THEME_NAMES, SHIKI_THEMES } from '../../src/lib/shiki.ts';

test('global Shiki themes tokenize code with GitHub light and dark colors', async () => {
  const highlighter = await createHighlighter({
    langs: ['typescript'],
    themes: SHIKI_THEME_NAMES
  });
  const result = highlighter.codeToTokens('const value = 1;', {
    lang: 'typescript',
    themes: SHIKI_THEMES
  });
  const keyword = result.tokens[0]?.[0];

  expect({
    background: result.bg,
    foreground: result.fg,
    keyword: {
      content: keyword?.content,
      dark: keyword?.htmlStyle?.['--shiki-dark'],
      light: keyword?.htmlStyle?.color
    }
  }).toEqual({
    background: '#fff;--shiki-dark-bg:#24292e',
    foreground: '#24292e;--shiki-dark:#e1e4e8',
    keyword: {
      content: 'const',
      dark: '#F97583',
      light: '#D73A49'
    }
  });

  highlighter.dispose();
});
