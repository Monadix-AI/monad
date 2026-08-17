import { setupDomTestEnvironment } from '../dom-test-env';

setupDomTestEnvironment();

import { expect, test } from 'bun:test';
import { InlineLink } from '@monad/ui';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ExternalLinkConfirmation } from '#/components/ExternalLinkConfirmation';

test('inline external links open only after the shared confirmation is accepted', async () => {
  const opened: string[] = [];
  const user = userEvent.setup();
  const originalOpen = window.open;
  window.open = (url) => {
    opened.push(String(url));
    return null;
  };
  try {
    render(
      <>
        <InlineLink href="https://example.com/docs">Example docs</InlineLink>
        <ExternalLinkConfirmation />
      </>
    );

    await user.click(screen.getByRole('link', { name: 'Example docs' }));
    expect({ opened, url: screen.getByText('https://example.com/docs').textContent }).toEqual({
      opened: [],
      url: 'https://example.com/docs'
    });

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('link', { name: 'Example docs' }));
    await user.click(screen.getByRole('button', { name: 'Open link' }));

    expect(opened).toEqual(['https://example.com/docs']);
  } finally {
    window.open = originalOpen;
  }
});
