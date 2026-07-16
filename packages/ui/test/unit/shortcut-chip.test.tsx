import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

test('ShortcutChip provides the shared semantic keycap treatment', async () => {
  const { ShortcutChip } = await import('../../src/components/ShortcutChip');
  const markup = renderToStaticMarkup(<ShortcutChip>⌘K</ShortcutChip>);

  expect(markup).toStartWith('<kbd');
  expect(markup).toContain('data-slot="shortcut-chip"');
  expect(markup).toContain('translate="no"');
  expect(markup).toContain('tabular-nums');
  expect(markup).toContain('h-4 min-w-7');
  expect(markup).toContain('rounded-full bg-sidebar-accent/85');
  expect(markup).toContain('text-[10px]');
  expect(markup).toContain('shadow-[inset_0_1px_0_rgb(255_255_255/0.08)]');
  expect(markup).toContain('⌘K');
});

test('dropdown menu shortcuts reuse ShortcutChip', async () => {
  const [{ DropdownMenuShortcut }, { ShortcutChip }] = await Promise.all([
    import('../../src/components/DropdownMenu'),
    import('../../src/components/ShortcutChip')
  ]);
  const shortcutMarkup = renderToStaticMarkup(<ShortcutChip>⌘K</ShortcutChip>);
  const menuMarkup = renderToStaticMarkup(<DropdownMenuShortcut>⌘K</DropdownMenuShortcut>);

  expect(menuMarkup).toStartWith('<kbd');
  expect(menuMarkup).toContain('data-slot="dropdown-menu-shortcut"');
  expect(menuMarkup).toContain('tabular-nums');
  expect(menuMarkup).toContain('shadow-[inset_0_1px_0_rgb(255_255_255/0.08)]');
  expect(shortcutMarkup).toContain('shadow-[inset_0_1px_0_rgb(255_255_255/0.08)]');
});
