import { expect, test } from 'bun:test';

import { CredentialActionsView } from '#/features/studio/capabilities-settings/ToolSettingsDialogs';

test('configured and newly entered credentials expose a removal action that invokes the supplied operation', () => {
  const removals: string[] = [];
  const configured = CredentialActionsView({
    configured: true,
    value: '',
    pendingRemoval: false,
    onRemove: () => removals.push('configured'),
    removeLabel: 'Remove credential',
    pendingLabel: 'Pending'
  });
  const entered = CredentialActionsView({
    configured: false,
    value: 'replacement',
    pendingRemoval: false,
    onRemove: () => removals.push('entered'),
    removeLabel: 'Remove credential',
    pendingLabel: 'Pending'
  });

  configured?.props.onClick();
  entered?.props.onClick();

  expect(removals).toEqual(['configured', 'entered']);
});

test('pending credential removal renders the supplied save consequence', () => {
  const pending = CredentialActionsView({
    configured: true,
    value: '',
    pendingRemoval: true,
    onRemove: () => {},
    removeLabel: 'Remove credential',
    pendingLabel: 'This credential will be removed when you save.'
  });

  expect(pending?.props.children).toBe('This credential will be removed when you save.');
});
