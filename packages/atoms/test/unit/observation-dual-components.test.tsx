import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  RawObservationCard,
  rawVirtualListControlProps
} from '../../src/workplace-experiences/chat-room/components/observation/raw-observation-list.tsx';
import { rawDisplayEntries } from '../../src/workplace-experiences/chat-room/components/observation/raw-view.ts';

test('raw display parsing formats JSON records without changing non-JSON text', () => {
  expect([
    rawDisplayEntries('{"k":"v"}', 'parsed'),
    rawDisplayEntries('plain text', 'parsed'),
    rawDisplayEntries('{"a":1}\n{"b":2}\n', 'lines')
  ]).toEqual([['{\n  "k": "v"\n}'], ['plain text'], ['{"a":1}', '{"b":2}']]);
});

test('raw observation renders ANSI log frames without visible control sequences', () => {
  const text = '\u001b[90m2026-08-19T11:23:25.205+08:00\u001b[39m \u001b[36m[gateway]\u001b[39m loading configuration…';
  const html = renderToStaticMarkup(
    <RawObservationCard
      row={{ identity: 'raw-ansi', cursor: 'raw-ansi', stream: 'stderr', preview: text }}
      text={text}
    />
  );

  expect(html.replace(/<[^>]+>/g, '')).toContain('2026-08-19T11:23:25.205+08:00 [gateway] loading configuration…');
  expect(html.includes('\u001b')).toBe(false);
});

test('raw list stays end-anchored and gates older-page loads at the boundary', () => {
  const card = { row: { identity: 'r1', cursor: 'r1', stream: 'unknown' as const, preview: 'x' }, text: 'x' };
  const cards = [card];
  const idle = rawVirtualListControlProps({ cards, canLoadOlderEvents: true, loadingOlderEvents: false });

  expect({ key: idle.getKey(card), stickToBottom: idle.stickToBottom }).toEqual({
    key: 'r1',
    stickToBottom: true
  });
  expect(idle.items).toBe(cards);

  let loadCalls = 0;
  const onLoadOlderEvents = () => {
    loadCalls += 1;
  };
  rawVirtualListControlProps({
    cards,
    canLoadOlderEvents: true,
    loadingOlderEvents: false,
    onLoadOlderEvents
  }).onStartReached();
  expect(loadCalls).toBe(1);

  expect(
    rawVirtualListControlProps({
      cards,
      canLoadOlderEvents: true,
      loadingOlderEvents: true,
      onLoadOlderEvents
    }).onStartReached()
  ).toBe(false);
  expect(
    rawVirtualListControlProps({
      cards,
      canLoadOlderEvents: false,
      loadingOlderEvents: false,
      onLoadOlderEvents
    }).onStartReached()
  ).toBe(false);
  expect(loadCalls).toBe(1);
});
