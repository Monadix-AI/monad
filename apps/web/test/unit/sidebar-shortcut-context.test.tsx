import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  SidebarShortcutAllocatorProvider,
  useSidebarSessionShortcutValue
} from '../../src/features/shell/sidebar/sidebar-shortcut-context';

function ShortcutProbe({ observed, rowKey }: { observed: number[]; rowKey: string }) {
  const shortcut = useSidebarSessionShortcutValue(rowKey);
  if (shortcut !== undefined) observed.push(shortcut);
  return null;
}

test('replayed renders reuse a row shortcut without consuming the next number', () => {
  const observed: number[] = [];
  renderToStaticMarkup(
    <SidebarShortcutAllocatorProvider>
      <ShortcutProbe
        observed={observed}
        rowKey="chat:first"
      />
      <ShortcutProbe
        observed={observed}
        rowKey="chat:first"
      />
      <ShortcutProbe
        observed={observed}
        rowKey="chat:second"
      />
      <ShortcutProbe
        observed={observed}
        rowKey="chat:second"
      />
    </SidebarShortcutAllocatorProvider>
  );

  expect(observed).toEqual([1, 1, 2, 2]);
});
