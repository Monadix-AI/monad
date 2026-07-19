import type { Ref } from 'react';
import type { RawDisplayMode, RawFrameRow } from './raw-view.ts';

import { workspaceMono as mono, workspaceSans as sans } from '@monad/ui/components/AgentAvatar';
import { CodeBlock } from '@monad/ui/components/CodeBlock';
import { VirtualList, type VirtualListHandle } from '@monad/ui/components/VirtualList';
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef } from 'react';

import { rawDisplayEntries } from './raw-view.ts';

const STREAM_LABEL: Record<RawFrameRow['stream'], string> = {
  stdout: 'stdout',
  stderr: 'stderr',
  unknown: 'raw'
};

export interface RawObservationListHandle {
  scrollToTop: (behavior?: ScrollBehavior) => void;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
}

export interface RawDisplayCard {
  row: RawFrameRow;
  text: string;
}

const rawCardKey = (card: RawDisplayCard): string => card.row.identity;

export interface RawVirtualListControlProps {
  getKey: (card: RawDisplayCard) => string;
  items: RawDisplayCard[];
  onStartReached: () => void;
  stickToBottom: true;
}

// The scalar props that decide VirtualList's scroll/anchor behavior, factored out so a test can
// assert the exact wiring without a DOM: `RawObservationList` spreads this SAME object into its
// `<VirtualList>` call below, so there is no second copy to drift out of sync with what's tested.
//
// `stickToBottom` is constant true — same as the chat transcript's VirtualList usage — so the
// raw list stays permanently `anchorTo:'end'`. That is what makes prepending an older page a
// no-op for the reader's scroll position (react-virtual's own end-anchoring absorbs it) instead of
// requiring a hand-rolled compensation; flipping it with a "follow latest" state (as the detail
// timeline used to) is exactly what reintroduces the chained-reload bug this migration fixes.
export function rawVirtualListControlProps(args: {
  cards: RawDisplayCard[];
  canLoadOlderEvents: boolean;
  loadingOlderEvents: boolean;
  onLoadOlderEvents?: () => void;
}): RawVirtualListControlProps {
  return {
    getKey: rawCardKey,
    items: args.cards,
    onStartReached: () => {
      if (args.canLoadOlderEvents && !args.loadingOlderEvents) args.onLoadOlderEvents?.();
    },
    stickToBottom: true
  };
}

// One raw frame's card, kept separate from the VirtualList-backed list below: VirtualList only
// paints rows once mounted client-side, so an SSR test against RawObservationList never sees a
// row's title/body — this component is what the SSR test suite renders directly instead.
export function RawObservationCard({
  row,
  text,
  displayMode = 'lines'
}: RawDisplayCard & { displayMode?: RawDisplayMode }): React.ReactElement {
  return (
    <div
      data-observation-raw-row={row.cursor}
      data-raw-card-id={row.identity}
      style={{
        border: '1px solid var(--border)',
        borderRadius: 8,
        background: 'var(--secondary)',
        boxSizing: 'border-box',
        display: 'grid',
        overflow: 'hidden'
      }}
    >
      <div
        style={{
          alignItems: 'center',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          gap: 10,
          justifyContent: 'space-between',
          minWidth: 0,
          padding: '7px 10px'
        }}
      >
        <span
          style={{
            color: 'var(--muted-foreground)',
            flex: 'none',
            fontFamily: mono,
            fontSize: 10,
            fontWeight: 700,
            textTransform: 'uppercase'
          }}
        >
          {STREAM_LABEL[row.stream]}
        </span>
        <span
          style={{
            color: 'var(--muted-foreground)',
            fontFamily: mono,
            fontSize: 10,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
          title={row.identity}
        >
          {row.identity}
        </span>
      </div>
      {displayMode === 'parsed' ? (
        <div
          data-observation-raw-preview={row.identity}
          style={{
            background: 'var(--background)',
            boxSizing: 'border-box',
            maxHeight: 256,
            minHeight: 40,
            minWidth: 0,
            overflow: 'auto',
            width: '100%'
          }}
        >
          <CodeBlock
            className="rounded-none border-0 bg-transparent [&_pre]:p-3 [&_pre]:text-xs [&_pre]:leading-relaxed"
            code={text}
            language="json"
          />
        </div>
      ) : (
        <pre
          data-observation-raw-preview={row.identity}
          style={{
            background: 'var(--background)',
            boxSizing: 'border-box',
            color: 'var(--foreground)',
            display: 'block',
            fontFamily: mono,
            fontSize: 12,
            lineHeight: 1.5,
            margin: 0,
            maxHeight: 256,
            minHeight: 40,
            minWidth: 0,
            overflowX: 'auto',
            overflowY: 'auto',
            padding: 12,
            whiteSpace: 'pre',
            width: '100%'
          }}
        >
          {text}
        </pre>
      )}
    </div>
  );
}

// The raw plane remains provider-verbatim. Lines/Parsed are presentation choices over the retained
// preview only; neither path mutates or feeds data back into projection.
//
// Scroll/prepend/edge behavior is delegated entirely to @monad/ui VirtualList — the same component
// the chat transcript uses — rather than a second reverse-pagination implementation.
export function RawObservationList({
  rows,
  displayMode = 'lines',
  canLoadOlderEvents = false,
  loadingOlderEvents = false,
  onLoadOlderEvents,
  controlRef
}: {
  rows: RawFrameRow[];
  displayMode?: RawDisplayMode;
  canLoadOlderEvents?: boolean;
  loadingOlderEvents?: boolean;
  onLoadOlderEvents?: () => void;
  controlRef?: Ref<RawObservationListHandle>;
}): React.ReactElement {
  const listRef = useRef<VirtualListHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pageAnchorRef = useRef<{ identity: string; offset: number } | null>(null);
  const previousLoadingOlderRef = useRef(loadingOlderEvents);
  const cards = useMemo<RawDisplayCard[]>(
    () => rows.map((row) => ({ row, text: rawDisplayEntries(row.preview, displayMode).join('\n') })),
    [displayMode, rows]
  );

  const rawScroller = useCallback(() => containerRef.current?.querySelector<HTMLElement>('[role="log"]') ?? null, []);
  const rawRowOffset = useCallback(
    (identity: string): number | null => {
      const scroller = rawScroller();
      if (!scroller) return null;
      const row = [...scroller.querySelectorAll<HTMLElement>('[data-raw-card-id]')].find(
        (candidate) => candidate.dataset.rawCardId === identity
      );
      if (!row) return null;
      return row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    },
    [rawScroller]
  );
  const loadedStartOffset = useCallback((): number | null => {
    const scroller = rawScroller();
    const row = scroller?.querySelector<HTMLElement>('[data-index="0"]');
    if (!scroller || !row) return 35;
    return row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  }, [rawScroller]);

  const loadOlderFromStart = useCallback(() => {
    const firstIdentity = rows[0]?.identity;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const offset = firstIdentity ? (rawRowOffset(firstIdentity) ?? loadedStartOffset()) : null;
        if (firstIdentity && offset !== null) pageAnchorRef.current = { identity: firstIdentity, offset };
        onLoadOlderEvents?.();
      });
    });
  }, [loadedStartOffset, onLoadOlderEvents, rawRowOffset, rows]);

  useEffect(() => {
    if (loadingOlderEvents && !previousLoadingOlderRef.current) {
      const first = rows[0];
      const offset = first ? (rawRowOffset(first.identity) ?? loadedStartOffset()) : null;
      if (first && offset !== null) pageAnchorRef.current = { identity: first.identity, offset };
    }
    previousLoadingOlderRef.current = loadingOlderEvents;
  }, [loadedStartOffset, loadingOlderEvents, rawRowOffset, rows]);

  const firstRowIdentity = rows[0]?.identity ?? null;
  useLayoutEffect(() => {
    const anchor = pageAnchorRef.current;
    if (!anchor || firstRowIdentity === anchor.identity) return;
    window.setTimeout(() => {
      const scroller = rawScroller();
      const offset = rawRowOffset(anchor.identity);
      if (!scroller || offset === null) return;
      scroller.scrollTop += offset - anchor.offset;
    }, 80);
    pageAnchorRef.current = null;
  }, [firstRowIdentity, rawRowOffset, rawScroller]);

  useImperativeHandle(
    controlRef,
    () => ({
      scrollToTop: (behavior = 'auto') => listRef.current?.scrollToTop(behavior),
      scrollToBottom: (behavior = 'auto') => listRef.current?.scrollToBottom(behavior)
    }),
    []
  );

  if (rows.length === 0) {
    return (
      <div
        data-observation-raw="empty"
        style={{
          alignItems: 'center',
          boxSizing: 'border-box',
          color: 'var(--muted-foreground)',
          display: 'flex',
          fontFamily: sans,
          fontSize: 13,
          height: '100%',
          justifyContent: 'center',
          padding: 14,
          textAlign: 'center',
          width: '100%'
        }}
      >
        {loadingOlderEvents ? 'Loading events…' : 'No raw frames yet'}
      </div>
    );
  }

  const listHeader = (
    <div
      data-events-state={loadingOlderEvents ? 'loading' : canLoadOlderEvents ? 'more' : 'start'}
      style={{
        boxSizing: 'border-box',
        color: 'var(--muted-foreground)',
        fontFamily: sans,
        fontSize: 11,
        padding: '12px 14px 10px',
        textAlign: 'center'
      }}
    >
      {loadingOlderEvents
        ? 'Loading earlier events…'
        : canLoadOlderEvents
          ? 'Scroll up for earlier events'
          : 'Start of events'}
    </div>
  );
  const listFooter = <div style={{ height: 62 }} />;

  return (
    <div
      ref={containerRef}
      style={{ height: '100%', minHeight: 0, width: '100%' }}
    >
      <VirtualList
        {...rawVirtualListControlProps({
          cards,
          canLoadOlderEvents,
          loadingOlderEvents,
          onLoadOlderEvents: loadOlderFromStart
        })}
        ariaLive="polite"
        className="scwf-scroll monad-selectable"
        controlRef={listRef}
        footer={listFooter}
        header={listHeader}
        overscan={400}
        renderItem={(card) => (
          <div style={{ boxSizing: 'border-box', padding: '0 14px 8px', width: '100%' }}>
            <RawObservationCard
              displayMode={displayMode}
              row={card.row}
              text={card.text}
            />
          </div>
        )}
        role="log"
        style={{
          boxSizing: 'border-box',
          height: '100%',
          overflowX: 'hidden',
          overscrollBehavior: 'contain',
          width: '100%'
        }}
      />
    </div>
  );
}
