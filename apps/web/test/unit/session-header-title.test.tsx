import { setupDomTestEnvironment } from '../dom-test-env';

setupDomTestEnvironment();

import { expect, mock, test } from 'bun:test';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SessionHeaderTitle } from '../../src/features/session/SessionHeader';

test('session header renames the current session inline', async () => {
  const onRename = mock((_title: string) => {});
  render(
    <SessionHeaderTitle
      onRename={onRename}
      renameLabel="Rename session"
      title="Initial title"
    />
  );

  const title = screen.getByText('Initial title');
  await userEvent.click(screen.getByRole('button', { name: 'Rename session' }));
  const input = screen.getByRole('textbox', { name: 'Rename session' });
  expect(input).toBe(title);
  expect(window.getSelection()?.isCollapsed).toBe(true);
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  expect(onRename.mock.calls).toEqual([]);
  expect(screen.getByRole('textbox', { name: 'Rename session' })).toBe(input);
  await userEvent.clear(input);
  await userEvent.type(input, 'Updated title{Enter}');

  expect(onRename.mock.calls).toEqual([['Updated title']]);
});
