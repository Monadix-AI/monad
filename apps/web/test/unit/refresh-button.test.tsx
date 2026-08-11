import { expect, test } from 'bun:test';
import { Children } from 'react';

import { RefreshButtonView } from '../../src/components/RefreshButton';

test('refresh button invokes refresh', () => {
  let refreshes = 0;
  const action = RefreshButtonView({
    label: 'Refresh',
    loading: false,
    onClick: () => {
      refreshes += 1;
    }
  });

  action.props.onClick?.({} as never);

  expect(refreshes).toBe(1);
});

test('refresh button disables while loading and preserves its variant', () => {
  const action = RefreshButtonView({
    disabled: false,
    label: 'Rebuild preview',
    loading: true,
    variant: 'outline'
  });
  expect({
    disabled: action.props.disabled,
    variant: action.props.variant
  }).toEqual({
    disabled: true,
    variant: 'outline'
  });
});

test('icon-only refresh keeps its label as the accessible name', () => {
  const action = RefreshButtonView({
    'aria-label': 'Reload catalog',
    disabled: true,
    iconOnly: true,
    label: 'Refresh',
    loading: false,
    size: 'icon'
  });
  expect({
    ariaLabel: action.props['aria-label'],
    disabled: action.props.disabled,
    size: action.props.size,
    textChildren: Children.toArray(action.props.children).filter((child) => typeof child === 'string')
  }).toEqual({
    ariaLabel: 'Reload catalog',
    disabled: true,
    size: 'icon',
    textChildren: []
  });
});
