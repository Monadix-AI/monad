import { expect, test } from 'bun:test';

import { buttonVariants } from '../../src/components/Button';

test('colored button variants use saturated text on a translucent semantic background', () => {
  const variants = ['default', 'destructive', 'success', 'warning', 'info'] as const;

  for (const variant of variants) {
    const classes = buttonVariants({ variant }).split(' ');
    expect(classes.some((className) => className.startsWith('text-'))).toBe(true);
    expect(
      classes.some((className) => /^bg-.+\/(10|12|20)$/.test(className) || className === 'bg-accent-blue-soft')
    ).toBe(true);
    expect(classes).not.toContain('text-primary-foreground');
    expect(classes).not.toContain('text-destructive-foreground');
  }
});

test('extra-large icon buttons preserve a true 36px control size', () => {
  expect(buttonVariants({ size: 'icon-xl' }).split(' ')).toContain('size-[36px]');
});

test('button variants use borderless styling with visible keyboard focus', () => {
  const variants = [
    'default',
    'destructive',
    'success',
    'warning',
    'info',
    'outline',
    'secondary',
    'ghost',
    'link'
  ] as const;

  for (const variant of variants) {
    const classes = buttonVariants({ variant }).split(' ');
    expect(classes.filter((className) => className.startsWith('border'))).toEqual([]);
    expect(classes).toContain('focus-visible:ring-[3px]');
    expect(classes).toContain('focus-visible:ring-ring/35');
  }
});
