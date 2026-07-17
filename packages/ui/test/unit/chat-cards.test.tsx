import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { ObservationCard, ObservationMeta, ObservationText } from '../../src/components/ObservationCard';
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

test('ObservationCard renders collapse state supplied by its consumer', () => {
  const collapsed = renderToStaticMarkup(
    <ObservationCard
      collapsed
      header={
        <ObservationMeta
          label="tool"
          source="codex"
          title="Read file"
        />
      }
      onCollapsedChange={() => {}}
      timestamp="2026-07-17T00:00:00.000Z"
      visualRole="tool"
    >
      <ObservationText
        observationRole="tool"
        text="package.json"
      />
    </ObservationCard>
  );
  const expanded = renderToStaticMarkup(
    <ObservationCard
      collapsed={false}
      header={
        <ObservationMeta
          label="tool"
          source="codex"
          title="Read file"
        />
      }
      onCollapsedChange={() => {}}
      timestamp="2026-07-17T00:00:00.000Z"
      visualRole="tool"
    >
      <ObservationText
        observationRole="tool"
        text="package.json"
      />
    </ObservationCard>
  );

  expect(collapsed).toContain('aria-expanded="false"');
  expect(collapsed).not.toContain('package.json');
  expect(expanded).toContain('aria-expanded="true"');
  expect(expanded).toContain('package.json');
  expect(expanded).toContain('2026-07-17T00:00:00.000Z');
});
