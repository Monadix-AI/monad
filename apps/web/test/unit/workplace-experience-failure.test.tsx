// Must be the first import in the file — it registers happy-dom before anything below imports
// @testing-library/react, which snapshots `document` availability at its own module-eval time.
import { setupDomTestEnvironment } from '../dom-test-env';

setupDomTestEnvironment();

import { expect, mock, test } from 'bun:test';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { WorkplaceExperienceErrorBoundary } from '../../src/features/workplace/experiences/WorkplaceExperienceErrorBoundary';

function Crasher({ crash }: { crash: { value: boolean } }): React.ReactElement {
  if (crash.value) throw new Error('experience exploded');
  return <div>experience content</div>;
}

test('a crashing experience is contained and recovers when retried', async () => {
  const consoleError = mock(() => {});
  // biome-ignore lint/suspicious/noConsole: React logs the caught error itself; silence it for the run.
  const original = console.error;
  console.error = consoleError as unknown as typeof console.error;
  const crash = { value: true };

  try {
    render(
      <WorkplaceExperienceErrorBoundary experienceId="kanban">
        <Crasher crash={crash} />
      </WorkplaceExperienceErrorBoundary>
    );
    expect(screen.queryByText('experience content')).toBeNull();

    crash.value = false;
    await userEvent.click(screen.getByRole('button'));

    expect(screen.queryByRole('button')).toBeNull();
    expect(document.body.textContent).toContain('experience content');
    const logged = (consoleError.mock.calls as unknown as unknown[][]).map((call) => call[0]);
    expect(logged).toContain('workplace experience "kanban" failed to render');
  } finally {
    console.error = original;
  }
});

test('switching to another experience clears the previous one’s failure', () => {
  const consoleError = mock(() => {});
  // biome-ignore lint/suspicious/noConsole: React logs the caught error itself; silence it for the run.
  const original = console.error;
  console.error = consoleError as unknown as typeof console.error;
  const crash = { value: true };

  try {
    const { rerender } = render(
      <WorkplaceExperienceErrorBoundary experienceId="kanban">
        <Crasher crash={crash} />
      </WorkplaceExperienceErrorBoundary>
    );
    expect(screen.queryByText('experience content')).toBeNull();

    crash.value = false;
    rerender(
      <WorkplaceExperienceErrorBoundary experienceId="chat-room">
        <Crasher crash={crash} />
      </WorkplaceExperienceErrorBoundary>
    );

    expect(document.body.textContent).toContain('experience content');
  } finally {
    console.error = original;
  }
});
