import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { activeMessageOutlineIds, MessageOutline, type MessageOutlineItem } from '../../src/components/MessageOutline';

const outlineItems: MessageOutlineItem[] = [
  { id: 'u1', index: 0, label: 'First', time: '1 minute ago' },
  { id: 'u2', index: 3, label: 'Second', time: 'Now' },
  { id: 'u3', index: 6, label: 'Third', time: 'Now' }
];

test('activeMessageOutlineIds maps visible rows to the user-message sections they belong to', () => {
  // Rows 2-4 span the section opened by u1 (rows 0-2) and the one opened by u2 (rows 3-5).
  expect(activeMessageOutlineIds(outlineItems, { startIndex: 2, endIndex: 4 }, 8)).toEqual(new Set(['u1', 'u2']));
  expect(activeMessageOutlineIds(outlineItems, null, 8)).toEqual(new Set(['u3']));
});

test('MessageOutline renders only after five items and marks active sections', () => {
  const items = Array.from({ length: 6 }, (_, index) => ({
    id: `u${index + 1}`,
    index,
    label: `Message ${index + 1}`,
    time: 'Now'
  }));
  const props = {
    activeIds: new Set(['u2']),
    ariaLabel: 'User message outline',
    goToLabel: (item: MessageOutlineItem) => `Go to ${item.label}`,
    onSelect: () => {},
    renderPreview: (item: MessageOutlineItem) => <p>{item.label}</p>
  };

  expect(
    renderToStaticMarkup(
      <MessageOutline
        {...props}
        items={items.slice(0, 5)}
      />
    )
  ).toBe('');

  const markup = renderToStaticMarkup(
    <MessageOutline
      {...props}
      items={items}
    />
  );
  expect(markup.match(/<button/g)?.length).toBe(6);
  expect(markup.match(/aria-current="location"/g)?.length).toBe(1);
  expect(markup).toContain('aria-label="Go to Message 2"');
});
