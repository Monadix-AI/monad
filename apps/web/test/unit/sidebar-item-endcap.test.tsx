import { expect, test } from 'bun:test';

import { resolveSidebarEndcapSlot } from '../../src/features/shell/sidebar/workspace-tree-item';

test('keeps the menu action active when shortcut mode starts while its menu is open', () => {
  expect(
    resolveSidebarEndcapSlot({
      actionsVisible: true,
      hasStatus: true,
      menuOpen: true,
      shortcutVisible: true
    })
  ).toBe('actions');
});
