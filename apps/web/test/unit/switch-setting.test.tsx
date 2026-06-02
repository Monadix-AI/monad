import { setupDomTestEnvironment } from '../dom-test-env';

setupDomTestEnvironment();

import { expect, test } from 'bun:test';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';

import { SwitchSetting } from '#/components/ui/switch-setting';

function SwitchSettingHarness() {
  const [checked, setChecked] = useState(false);
  return (
    <SwitchSetting
      checked={checked}
      description="Remove old logs automatically."
      onCheckedChange={setChecked}
      title="Automatic cleanup"
    />
  );
}

test('the titled setting toggles through its accessible switch', async () => {
  render(<SwitchSettingHarness />);
  const toggle = screen.getByRole('switch', {
    description: 'Remove old logs automatically.',
    name: 'Automatic cleanup'
  });

  await userEvent.click(toggle);

  expect(toggle.getAttribute('aria-checked')).toBe('true');
});
