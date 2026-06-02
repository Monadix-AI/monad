import type { ReactElement } from 'react';

import { expect, test } from 'bun:test';
import { createElement } from 'react';

import { PanelShellHeader } from '../../src/components/ui/panel-shell';

test('the inbox header keeps filters left and refresh actions right', () => {
  let filterChanges = 0;
  let refreshes = 0;
  const leading = createElement(
    'button',
    {
      onClick: () => {
        filterChanges += 1;
      },
      type: 'button'
    },
    'Unread'
  );
  const actions = createElement(
    'button',
    {
      onClick: () => {
        refreshes += 1;
      },
      type: 'button'
    },
    'Refresh'
  );
  const header = PanelShellHeader({
    actions,
    leading
  } as React.ComponentProps<typeof PanelShellHeader>);
  const renderedLeading = header.props.children[0].props.children as ReactElement<{ onClick: () => void }>;
  const renderedAction = header.props.children[2].props.children as ReactElement<{ onClick: () => void }>;

  renderedLeading.props.onClick();
  renderedAction.props.onClick();

  expect(filterChanges).toBe(1);
  expect(refreshes).toBe(1);
});
