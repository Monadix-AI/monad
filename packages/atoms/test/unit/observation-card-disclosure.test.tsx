import type { ReactElement } from 'react';

import { expect, test } from 'bun:test';
import { fireEvent, render } from '@testing-library/react';

import {
  createObservationDisclosureStore,
  ObservationDisclosureProvider,
  ObservationDisclosureScope
} from '../../src/workplace-experiences/chat-room/components/observation/disclosure.tsx';
import { MonadMcpLongText } from '../../src/workplace-experiences/chat-room/components/observation/monad-mcp-long-text.tsx';
import { setupDomTestEnvironment } from '../dom-test-env.ts';

setupDomTestEnvironment();

const longText = Array.from({ length: 9 }, (_, index) => `Line ${index + 1}`).join('\n');

function tree(store: ReturnType<typeof createObservationDisclosureStore>, scope: string): ReactElement {
  return (
    <ObservationDisclosureProvider store={store}>
      <ObservationDisclosureScope id={scope}>
        <MonadMcpLongText
          disclosureKey="body"
          text={longText}
        />
      </ObservationDisclosureScope>
    </ObservationDisclosureProvider>
  );
}

test('an expanded card returns expanded after the virtualized row unmounts and remounts', async () => {
  const store = createObservationDisclosureStore();
  const mounted = render(tree(store, 'row-1'));
  fireEvent.click(mounted.getByRole('button'));
  mounted.unmount();

  const remounted = render(tree(store, 'row-1'));
  const afterRemount = remounted.getByRole('button').getAttribute('aria-expanded') === 'true';

  expect(afterRemount).toBe(true);
});

test('expanding one row leaves another row collapsed', async () => {
  const store = createObservationDisclosureStore();
  const expandedRow = render(tree(store, 'row-1'));
  fireEvent.click(expandedRow.getByRole('button'));
  expandedRow.unmount();

  const otherRow = render(tree(store, 'row-2'));
  const neighbourExpanded = otherRow.getByRole('button').getAttribute('aria-expanded') === 'true';

  expect(neighbourExpanded).toBe(false);
});
