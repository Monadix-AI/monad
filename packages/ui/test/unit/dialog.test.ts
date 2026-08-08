import { expect, test } from 'bun:test';

import { dialogContentVariants } from '../../src/components/Dialog';
import { dialogFooterClassName } from '../../src/components/dialog-styles';

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
  expect(classNames.every((tokens) => tokens.includes('rounded-2xl'))).toBe(true);
});

test('dialog footer sizes buttons by element so Radix asChild slot replacement cannot bypass it', () => {
  const classes = dialogFooterClassName.split(' ');

  expect(classes).toContain('[&_button]:h-[44px]');
  expect(classes).toContain('sm:[&_button]:h-[36px]');
  expect(classes).toContain('[&_button]:min-w-[80px]');
  expect(classes).toContain('[&_button]:px-4');
  expect(classes.some((className) => className.includes('data-slot=button'))).toBe(false);
});
