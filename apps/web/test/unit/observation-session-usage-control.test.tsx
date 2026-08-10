import { setupDomTestEnvironment } from '../dom-test-env';

setupDomTestEnvironment();

import { expect, test } from 'bun:test';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MeshAgentObservationPanel } from '../../../../packages/atoms/src/workplace-experiences/chat-room/components/observation/panel';

const meter = {
  cachedInput: 1_200,
  contextMeterPercent: 42,
  contextPercent: 42,
  contextUsed: 42_000,
  contextWindow: 100_000,
  input: 30_000,
  output: 8_000,
  reasoningOutput: 2_800,
  total: 42_000
};

test('places session usage after the agent name and provider icon', () => {
  render(
    <MeshAgentObservationPanel
      agentName="GPT 5.6 Sol"
      icon="codex"
      sessionUsageMeter={meter}
    />
  );

  const name = screen.getByTitle('GPT 5.6 Sol');
  const providerIcon = screen.getAllByRole('img', { name: 'OpenAI Codex' }).at(-1);
  const usage = screen.getByRole('button', { name: 'Show session usage' });
  if (!providerIcon) throw new Error('Expected identity provider icon');

  expect({
    iconFollowsName: Boolean(name.compareDocumentPosition(providerIcon) & Node.DOCUMENT_POSITION_FOLLOWING),
    label: usage.textContent,
    usageFollowsIcon: Boolean(providerIcon.compareDocumentPosition(usage) & Node.DOCUMENT_POSITION_FOLLOWING)
  }).toEqual({ iconFollowsName: true, label: '42%', usageFollowsIcon: true });
});

test('opens a compact session usage summary with context and token totals', async () => {
  render(
    <MeshAgentObservationPanel
      agentName="GPT 5.6 Sol"
      icon="codex"
      sessionUsageMeter={meter}
    />
  );

  await userEvent.click(screen.getByRole('button', { name: 'Show session usage' }));
  const dialog = screen.getByRole('dialog', { name: 'Session usage' });

  expect(within(dialog).getByText('42K / 100K').textContent).toBe('42K / 100K');
  expect(dialog.textContent).toBe(
    'Context window42%42K / 100KInput tokens30,000Cached input1,200Output tokens8,000Reasoning output2,800Total tokens42,000'
  );
});

test('renders an unrecoverable native session notice above the observation body', () => {
  render(
    <MeshAgentObservationPanel
      agentName="Claude"
      nativeSessionUnavailable
      observationUnavailable
    />
  );

  const notice = screen.getByRole('status');
  const emptyState = document.querySelector('[data-observation-state="unavailable"]');
  if (!emptyState) throw new Error('Expected unavailable observation body');
  expect({
    copy: notice.textContent,
    genericCopyHidden: screen.queryByText('Agent events unavailable') === null,
    noticeBeforeBody: Boolean(notice.compareDocumentPosition(emptyState) & Node.DOCUMENT_POSITION_FOLLOWING)
  }).toEqual({
    copy: 'Native session history unavailableThe original session was deleted or archived and cannot be restored.',
    genericCopyHidden: true,
    noticeBeforeBody: true
  });
});
