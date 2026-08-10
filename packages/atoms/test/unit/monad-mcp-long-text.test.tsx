import { expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  MonadMcpLongText,
  monadMcpTextNeedsCollapse
} from '../../src/workplace-experiences/chat-room/components/observation/monad-mcp-long-text.tsx';

function renderedText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(renderedText).join(' ');
  if (!value || typeof value !== 'object') return '';
  return renderedText((value as { children?: unknown }).children);
}

test('short Monad MCP text stays fully visible without a disclosure control', () => {
  const markup = renderToStaticMarkup(
    <MonadMcpLongText
      disclosureKey="short"
      text="Focused validation passed."
    />
  );

  expect({
    collapsed: markup.includes('data-collapsed="false"'),
    disclosure: markup.includes('aria-expanded'),
    threshold: monadMcpTextNeedsCollapse('Focused validation passed.')
  }).toEqual({ collapsed: true, disclosure: false, threshold: false });
});

test('long Monad MCP text expands and collapses from its disclosure control', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const { act, create } = require('react-test-renderer') as {
    act: (run: () => void) => Promise<void>;
    create: (element: React.ReactElement) => {
      root: {
        findByType(type: string): { props: { 'aria-expanded': boolean; onClick: () => void } };
      };
      toJSON(): unknown;
      unmount(): void;
    };
  };
  const text = Array.from({ length: 9 }, (_, index) => `Line ${index + 1}`).join('\n');
  let renderer: ReturnType<typeof create> | undefined;
  await act(() => {
    renderer = create(
      <MonadMcpLongText
        disclosureKey="long"
        text={text}
      />
    );
  });
  const mounted = renderer;
  if (!mounted) throw new Error('Expected mounted long text');
  const initialButton = mounted.root.findByType('button');
  const initial = {
    expanded: initialButton.props['aria-expanded'],
    label: renderedText(mounted.toJSON()).replace(/\s+/g, ' ').trim()
  };
  await act(() => initialButton.props.onClick());
  const expandedButton = mounted.root.findByType('button');
  const expanded = {
    expanded: expandedButton.props['aria-expanded'],
    label: renderedText(mounted.toJSON()).replace(/\s+/g, ' ').trim()
  };
  await act(() => expandedButton.props.onClick());
  const collapsedAgain = mounted.root.findByType('button').props['aria-expanded'];
  await act(() => mounted.unmount());

  expect({ collapsedAgain, expanded, initial, threshold: monadMcpTextNeedsCollapse(text) }).toEqual({
    collapsedAgain: false,
    expanded: { expanded: true, label: `${text.replace(/\s+/g, ' ')} Show less` },
    initial: { expanded: false, label: `${text.replace(/\s+/g, ' ')} Show full content` },
    threshold: true
  });
});
