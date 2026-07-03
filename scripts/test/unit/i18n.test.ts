import { expect, test } from 'bun:test';

import { changedParaglideScopes, generatedFilesMatch } from '../../i18n.ts';

test('generatedFilesMatch requires exact path and content matches', () => {
  const expected = new Map([
    ['/repo/src/catalog-types.ts', 'types'],
    ['/repo/src/paraglide-input/en.json', '{"hello":"Hello"}\n']
  ]);

  expect(generatedFilesMatch(expected, new Map(expected))).toBe(true);
  expect(generatedFilesMatch(expected, new Map([['/repo/src/catalog-types.ts', 'types']]))).toBe(false);
  expect(generatedFilesMatch(expected, new Map([...expected, ['/repo/src/paraglide-input/extra.json', '{}\n']]))).toBe(
    false
  );
  expect(
    generatedFilesMatch(
      expected,
      new Map([
        ['/repo/src/catalog-types.ts', 'types'],
        ['/repo/src/paraglide-input/en.json', '{"hello":"Hi"}\n']
      ])
    )
  ).toBe(false);
});

test('changedParaglideScopes maps locale JSON edits to the owning Paraglide scope', () => {
  expect(changedParaglideScopes(['packages/i18n/src/locales/en/web.json'])).toEqual(['web']);
  expect(changedParaglideScopes(['packages/i18n/src/locales/zh/cli.json'])).toEqual(['cli']);
  expect(changedParaglideScopes(['packages/i18n/src/locales/en/channel.json'])).toEqual(['common']);
  expect(
    changedParaglideScopes(['packages/i18n/src/locales/en/web.json', 'packages/i18n/src/locales/en/cli.json'])
  ).toEqual(['cli', 'web']);
  expect(changedParaglideScopes(['packages/i18n/src/catalog-types.ts'])).toEqual([]);
});

test('i18n package exposes a start:dev watcher script', async () => {
  const pkg = (await Bun.file(new URL('../../../packages/i18n/package.json', import.meta.url)).json()) as {
    scripts?: Record<string, string>;
  };

  expect(pkg.scripts?.['start:dev']).toBe('bun ../../scripts/i18n.ts --watch');
});
