import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { RawInspectableCard, rawEventRecordsText } from '../../src/components/RawInspectableCard';

const labels = {
  copy: 'Copy raw JSON',
  hide: 'Hide raw JSONL',
  show: 'Show raw JSONL'
};

test('rawEventRecordsText preserves provider record order and exact text', () => {
  expect(
    rawEventRecordsText([
      { id: '1', text: '{"type":"call"}' },
      { id: '2', text: ' {"type":"result"} ' }
    ])
  ).toBe('{"type":"call"}\n {"type":"result"} ');
});

test('RawInspectableCard omits inspection controls without records', () => {
  const markup = renderToStaticMarkup(
    <RawInspectableCard
      labels={labels}
      onOpenChange={() => {}}
      open={false}
      records={[]}
    >
      <div>card</div>
    </RawInspectableCard>
  );

  expect(markup).toBe('<div>card</div>');
});

test('RawInspectableCard renders ordered JSONL only while controlled open', () => {
  const records = [
    { id: '1', text: '{"type":"call"}' },
    { id: '2', text: '{"type":"result"}' }
  ];
  const closed = renderToStaticMarkup(
    <RawInspectableCard
      labels={labels}
      onOpenChange={() => {}}
      open={false}
      records={records}
    >
      <div>card</div>
    </RawInspectableCard>
  );
  const open = renderToStaticMarkup(
    <RawInspectableCard
      labels={labels}
      onOpenChange={() => {}}
      open
      records={records}
    >
      <div>card</div>
    </RawInspectableCard>
  );

  expect(closed).toContain('aria-expanded="false"');
  expect(closed).not.toContain('&quot;type&quot;');
  expect(open).toContain('aria-expanded="true"');
  expect(open).toContain('{&quot;type&quot;:&quot;call&quot;}\n{&quot;type&quot;:&quot;result&quot;}');
});
