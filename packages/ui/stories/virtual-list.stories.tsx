import type { Meta, StoryObj } from '@storybook/react-vite';

import { useEffect, useRef, useState } from 'react';

import { VirtualList, type VirtualListHandle } from '../src/components/VirtualList';

const meta = {
  title: 'UI/VirtualList',
  parameters: {
    layout: 'fullscreen'
  }
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

type Row = { id: string; text: string };

const LOREM =
  'Virtual scrolling keeps the DOM small by rendering only the rows near the viewport. Measured heights replace estimates as rows mount, and the scrollbar must not visibly re-scale while that happens. ';

function historyRow(index: number): Row {
  return {
    id: `row_${index}`,
    // Alternate short and very tall rows so estimate-vs-measured gaps are the norm, not the edge case.
    text: `#${index} ${LOREM.repeat(index % 5 === 0 ? 14 : 1)}`
  };
}

/**
 * Manual regression surface for the chat behaviours no unit test can cover (mount timing, layout
 * races): initial landing must sit exactly on the bottom, a streaming row must keep the view
 * pinned, scrolling up must stop following, and the jump button must re-arm it.
 */
function StreamingChat(): React.ReactElement {
  const [rows, setRows] = useState<Row[]>(() => Array.from({ length: 60 }, (_, index) => historyRow(index)));
  const [streaming, setStreaming] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const listRef = useRef<VirtualListHandle>(null);

  useEffect(() => {
    if (!streaming) return;
    const timer = window.setInterval(() => {
      setRows((previous) => {
        const last = previous.at(-1);
        if (!last) return previous;
        const grown = { ...last, text: `${last.text} more streamed tokens arriving in place…` };
        return [...previous.slice(0, -1), grown];
      });
    }, 120);
    return () => window.clearInterval(timer);
  }, [streaming]);

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <div className="flex items-center gap-2 border-b p-2">
        <button
          className="rounded-md border px-3 py-1 text-sm"
          onClick={() => {
            setRows((previous) => [...previous, historyRow(previous.length)]);
          }}
          type="button"
        >
          Append row
        </button>
        <button
          className="rounded-md border px-3 py-1 text-sm"
          onClick={() => setStreaming((previous) => !previous)}
          type="button"
        >
          {streaming ? 'Stop streaming' : 'Stream last row'}
        </button>
        <button
          className="rounded-md border px-3 py-1 text-sm"
          onClick={() => listRef.current?.scrollToBottom('smooth')}
          type="button"
        >
          Jump to latest
        </button>
        <span className="text-muted-foreground text-sm">{atBottom ? 'following' : 'scrolled away'}</span>
      </div>
      <div className="relative min-h-0 flex-1">
        <VirtualList
          controlRef={listRef}
          getKey={(row) => row.id}
          items={rows}
          onAtBottomChange={setAtBottom}
          renderItem={(row) => <div className="border-b px-4 py-3 text-sm">{row.text}</div>}
          role="log"
          stickToBottom
        />
      </div>
    </div>
  );
}

export const StreamingChatFollow: Story = {
  render: () => <StreamingChat />
};
