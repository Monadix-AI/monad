import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  SidebarShortcutAllocatorProvider,
  useSidebarSessionShortcutValue
} from '../../src/features/shell/sidebar/sidebar-shortcut-context';

function ShortcutProbe({ rowKey }: { rowKey: string }) {
  return <span>{useSidebarSessionShortcutValue(rowKey)}</span>;
}

test('replayed renders reuse a row shortcut without consuming the next number', () => {
  const markup = renderToStaticMarkup(
    <SidebarShortcutAllocatorProvider>
      <ShortcutProbe rowKey="chat:first" />
      <ShortcutProbe rowKey="chat:first" />
      <ShortcutProbe rowKey="chat:second" />
      <ShortcutProbe rowKey="chat:second" />
    </SidebarShortcutAllocatorProvider>
  );

  expect(markup.replaceAll(/<[^>]+>/g, '')).toBe('1122');
});
