import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  createObservationDisclosureStore,
  ObservationDisclosureProvider,
  ObservationDisclosureScope
} from '../../src/workplace-experiences/chat-room/components/observation/disclosure.tsx';
import {
  PlanProgressCard,
  planProgressView
} from '../../src/workplace-experiences/chat-room/components/observation/plan-progress.tsx';

const runningPlan = {
  active: 'Implement the projection',
  completed: 1,
  steps: [
    { status: 'completed', step: 'Capture the baseline' },
    { status: 'inProgress', step: 'Implement the projection' },
    { status: 'pending', step: 'Report the handoff' }
  ],
  total: 3
};

function plainText(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function renderCard(payload: Record<string, unknown>, collapsed = false): { markup: string; open: boolean } {
  const store = createObservationDisclosureStore();
  if (collapsed) store.write('plan/card', false);
  const markup = renderToStaticMarkup(
    <ObservationDisclosureProvider store={store}>
      <ObservationDisclosureScope id="plan">
        <PlanProgressCard
          provider="codex"
          view={planProgressView(payload)}
        />
      </ObservationDisclosureScope>
    </ObservationDisclosureProvider>
  );
  return { markup, open: /<details[^>]*\sopen=""/.test(markup) };
}

function cardTitle(payload: Record<string, unknown>): string {
  const { markup } = renderCard(payload);
  return plainText(markup.slice(markup.indexOf('<summary'), markup.indexOf('</summary>')));
}

test('the plan card opens on the step being worked on and lists every step', () => {
  const rendered = renderCard(runningPlan);
  expect({ open: rendered.open, text: plainText(rendered.markup) }).toEqual({
    open: true,
    text: 'Plan (1/3): Implement the projection Capture the baseline Implement the projection Report the handoff'
  });
});

test('collapsing the plan card closes its disclosure and keeps the progress summary', () => {
  const collapsed = renderCard(runningPlan, true);
  expect({ open: collapsed.open, title: cardTitle(runningPlan) }).toEqual({
    open: false,
    title: 'Plan (1/3): Implement the projection'
  });
});

test('a finished plan reports completion instead of a current step', () => {
  expect(
    cardTitle({
      completed: 3,
      steps: runningPlan.steps.map((step) => ({ ...step, status: 'completed' })),
      total: 3
    })
  ).toBe('Plan complete (3/3)');
});
