import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { SidebarActionVisibilityRules, SidebarShortcutBadge } from '../../src/features/shell/sidebar/nav-item';
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

test('session shortcut chip only renders the state-selected content', () => {
  const chip = renderToStaticMarkup(
    <SidebarSessionShortcutChip
      modifierLabel="⌘"
      value={1}
    />
  );
  const rules = renderToStaticMarkup(<SidebarActionVisibilityRules />);

  expect(chip).toContain('⌘1');
  expect(chip).not.toContain('invisible');
  expect(chip).not.toContain('opacity-0');
  expect(chip).not.toContain('data-sidebar-shortcut-visible');
  expect(rules).toContain('[data-sidebar-actions-visible="true"]');
  expect(rules).not.toContain('[data-sidebar-shortcut-visible="true"]');
});
