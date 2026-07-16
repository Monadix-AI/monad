import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

test('MorphChevron renders down and up paths without rotating the svg', async () => {
  const componentModule = await import('../../src/components/MorphChevron').catch(() => null);

  expect(componentModule).not.toBeNull();
  if (!componentModule) return;

  const { MorphChevron } = componentModule;
  const collapsed = renderToStaticMarkup(<MorphChevron expanded={false} />);
  const expanded = renderToStaticMarkup(<MorphChevron expanded />);

  expect(collapsed).toContain('d="M6 9L12 15L18 9"');
  expect(expanded).toContain('d="M6 15L12 9L18 15"');
  expect(collapsed).not.toContain('rotate');
  expect(expanded).not.toContain('rotate');
});
