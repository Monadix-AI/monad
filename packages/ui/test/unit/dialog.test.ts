import { expect, test } from 'bun:test';

import { dialogContentVariants } from '../../src/components/Dialog';

test('dialog size configuration keeps one structured shell and maps every width explicitly', () => {
  const sizes = ['sm', 'md', 'lg', 'xl', 'wide'] as const;
  const classNames = sizes.map((size) => dialogContentVariants({ size }).split(' '));

  expect(classNames.map((tokens) => tokens.filter((token) => token.startsWith('sm:max-w-')))).toEqual([
    ['sm:max-w-md'],
    ['sm:max-w-lg'],
    ['sm:max-w-xl'],
    ['sm:max-w-3xl'],
    ['sm:max-w-5xl']
  ]);
  expect(
    classNames.map((tokens) =>
      tokens.filter((token) => ['flex', 'flex-col', 'gap-0', 'overflow-hidden', 'p-0'].includes(token))
    )
  ).toEqual(sizes.map(() => ['flex', 'flex-col', 'gap-0', 'overflow-hidden', 'p-0']));
});
