import { expect, test } from 'bun:test';
import { fireEvent, render } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  MonadMcpLongText,
  monadMcpTextNeedsCollapse
} from '../../src/workplace-experiences/chat-room/components/observation/monad-mcp-long-text.tsx';
import { setupDomTestEnvironment } from '../dom-test-env.ts';

setupDomTestEnvironment();

function renderedText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  return Array.from(node.childNodes, renderedText).join(' ');
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
  const text = Array.from({ length: 9 }, (_, index) => `Line ${index + 1}`).join('\n');
  const view = render(
    <MonadMcpLongText
      disclosureKey="long"
      text={text}
    />
  );
  const initialButton = view.getByRole('button');
  const initial = {
    expanded: initialButton.getAttribute('aria-expanded') === 'true',
    label: renderedText(view.container).replace(/\s+/g, ' ').trim()
  };
  fireEvent.click(initialButton);
  const expandedButton = view.getByRole('button');
  const expanded = {
    expanded: expandedButton.getAttribute('aria-expanded') === 'true',
    label: renderedText(view.container).replace(/\s+/g, ' ').trim()
  };
  fireEvent.click(expandedButton);
  const collapsedAgain = view.getByRole('button').getAttribute('aria-expanded') === 'true';

  expect({ collapsedAgain, expanded, initial, threshold: monadMcpTextNeedsCollapse(text) }).toEqual({
    collapsedAgain: false,
    expanded: { expanded: true, label: `${text.replace(/\s+/g, ' ')} Show less` },
    initial: { expanded: false, label: `${text.replace(/\s+/g, ' ')} Show full content` },
    threshold: true
  });
});
