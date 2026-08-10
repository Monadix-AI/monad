import { expect, test } from 'bun:test';
import React from 'react';

import {
  createObservationDisclosureStore,
  ObservationDisclosureProvider,
  ObservationDisclosureScope
} from '../../src/workplace-experiences/chat-room/components/observation/disclosure.tsx';
import { MonadMcpLongText } from '../../src/workplace-experiences/chat-room/components/observation/monad-mcp-long-text.tsx';

type Renderer = {
  root: { findByType(type: string): { props: { 'aria-expanded': boolean; onClick: () => void } } };
  unmount(): void;
};

function testRenderer(): {
  act: (run: () => void) => Promise<void>;
  create: (element: React.ReactElement) => Renderer;
} {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  return require('react-test-renderer') as {
    act: (run: () => void) => Promise<void>;
    create: (element: React.ReactElement) => Renderer;
  };
}

const longText = Array.from({ length: 9 }, (_, index) => `Line ${index + 1}`).join('\n');

function tree(store: ReturnType<typeof createObservationDisclosureStore>, scope: string): React.ReactElement {
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
  const { act, create } = testRenderer();
  const store = createObservationDisclosureStore();
  let first: Renderer | undefined;
  await act(() => {
    first = create(tree(store, 'row-1'));
  });
  const mounted = first;
  if (!mounted) throw new Error('Expected mounted card');
  await act(() => mounted.root.findByType('button').props.onClick());
  await act(() => mounted.unmount());

  let second: Renderer | undefined;
  await act(() => {
    second = create(tree(store, 'row-1'));
  });
  const remounted = second;
  if (!remounted) throw new Error('Expected remounted card');
  const afterRemount = remounted.root.findByType('button').props['aria-expanded'];
  await act(() => remounted.unmount());

  expect(afterRemount).toBe(true);
});

test('expanding one row leaves another row collapsed', async () => {
  const { act, create } = testRenderer();
  const store = createObservationDisclosureStore();
  let expandedRow: Renderer | undefined;
  await act(() => {
    expandedRow = create(tree(store, 'row-1'));
  });
  const mounted = expandedRow;
  if (!mounted) throw new Error('Expected mounted card');
  await act(() => mounted.root.findByType('button').props.onClick());
  await act(() => mounted.unmount());

  let otherRow: Renderer | undefined;
  await act(() => {
    otherRow = create(tree(store, 'row-2'));
  });
  const neighbour = otherRow;
  if (!neighbour) throw new Error('Expected neighbour card');
  const neighbourExpanded = neighbour.root.findByType('button').props['aria-expanded'];
  await act(() => neighbour.unmount());

  expect(neighbourExpanded).toBe(false);
});
