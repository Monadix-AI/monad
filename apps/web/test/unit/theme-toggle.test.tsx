import { setupDomTestEnvironment } from '../dom-test-env';

setupDomTestEnvironment();

import { beforeEach, expect, test } from 'bun:test';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ThemeToggle } from '#/components/ThemeToggle';

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: window.localStorage });
  localStorage.clear();
  document.documentElement.classList.remove('dark');
});

test('the sidebar theme menu applies and persists Auto, Dark, and Light preferences', async () => {
  const user = userEvent.setup();
  render(<ThemeToggle />);
  const trigger = screen.getByRole('button', { name: 'toggle theme' });

  await user.click(trigger);
  await user.click(await screen.findByRole('menuitemradio', { name: 'Dark' }));
  await waitFor(() => {
    expect(localStorage.getItem('monad:theme')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  await user.click(trigger);
  await user.click(await screen.findByRole('menuitemradio', { name: 'Light' }));
  await waitFor(() => {
    expect(localStorage.getItem('monad:theme')).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  await user.click(trigger);
  await user.click(await screen.findByRole('menuitemradio', { name: 'Auto' }));
  await waitFor(() => {
    expect(localStorage.getItem('monad:theme')).toBe('auto');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
