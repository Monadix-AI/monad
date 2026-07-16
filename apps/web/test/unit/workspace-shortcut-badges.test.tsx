import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  SIDEBAR_SHORTCUT_BADGE_OVERLAY_CLASS,
  SidebarActionVisibilityRules,
  SidebarShortcutBadge
} from '../../src/features/shell/sidebar/nav-item';
import { SidebarSessionShortcutChip } from '../../src/features/shell/sidebar/workspace-tree-item';

for (const modifierLabel of ['⌘', 'Ctrl']) {
  test(`shortcut badge renders the ${modifierLabel} modifier with its action key`, () => {
    expect(
      renderToStaticMarkup(
        <SidebarShortcutBadge
          modifierLabel={modifierLabel}
          value="`"
        />
      )
    ).toContain(`data-slot="shortcut-chip"`);
    expect(
      renderToStaticMarkup(
        <SidebarShortcutBadge
          modifierLabel={modifierLabel}
          value="I"
        />
      )
    ).toContain(`>${modifierLabel}I</kbd>`);
  });
}

test('session shortcut badges stay at the item right edge and hide on hover', () => {
  const chip = renderToStaticMarkup(<SidebarSessionShortcutChip />);
  const rules = renderToStaticMarkup(<SidebarActionVisibilityRules />);

  for (const className of SIDEBAR_SHORTCUT_BADGE_OVERLAY_CLASS.split(' ')) {
    expect(chip).toContain(className);
  }
  expect(chip).not.toContain('ml-auto');
  expect(rules).toContain('[data-sidebar-tree-item="true"]:hover [data-sidebar-shortcut-chip="true"]');
  expect(rules).toContain('opacity: 0');
});
