import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { SidebarShortcutBadge } from '../../src/features/shell/sidebar/nav-item';

for (const modifierLabel of ['⌘', 'Ctrl']) {
  test(`shortcut badge renders the ${modifierLabel} modifier with its action key`, () => {
    expect(
      renderToStaticMarkup(
        <SidebarShortcutBadge
          modifierLabel={modifierLabel}
          value="`"
        />
      )
    ).toBe(
      `<span class="inline-flex h-4 min-w-7 items-center justify-center gap-px rounded-full bg-sidebar-accent/85 px-1.5 font-medium text-[10px] text-muted-foreground tabular-nums shadow-[inset_0_1px_0_rgb(255_255_255/0.08)] backdrop-blur">${modifierLabel}\`</span>`
    );
    expect(
      renderToStaticMarkup(
        <SidebarShortcutBadge
          modifierLabel={modifierLabel}
          value="I"
        />
      )
    ).toBe(
      `<span class="inline-flex h-4 min-w-7 items-center justify-center gap-px rounded-full bg-sidebar-accent/85 px-1.5 font-medium text-[10px] text-muted-foreground tabular-nums shadow-[inset_0_1px_0_rgb(255_255_255/0.08)] backdrop-blur">${modifierLabel}I</span>`
    );
  });
}
