import type { Ref } from 'react';
import type { RawDisplayMode, RawFrameRow } from './raw-view.ts';

import { workspaceMono as mono, workspaceSans as sans } from '@monad/ui/components/AgentAvatar';
import { CodeBlock } from '@monad/ui/components/CodeBlock';
import { useImperativeHandle, useLayoutEffect, useMemo, useRef } from 'react';

import { rawDisplayEntries } from './raw-view.ts';

const STREAM_LABEL: Record<RawFrameRow['stream'], string> = {
  stdout: 'stdout',
  stderr: 'stderr',
  pty: 'pty',
  'app-server': 'app-server',
  unknown: 'raw'
};

export interface RawObservationListHandle {
  scrollToTop: (behavior?: ScrollBehavior) => void;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
}

interface RawDisplayCard {
  row: RawFrameRow;
  text: string;
}

// The raw plane remains provider-verbatim. Lines/Parsed are presentation choices over the retained
// preview only; neither path mutates or feeds data back into projection.
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
  const scrollerRef = useRef<HTMLDivElement>(null);
  const previousLayoutRef = useRef<{ firstKey: string | null; height: number }>({ firstKey: null, height: 0 });
  const startArmedRef = useRef(true);
  const pinnedRef = useRef(true);
  const cards = useMemo<RawDisplayCard[]>(
    () => rows.map((row) => ({ row, text: rawDisplayEntries(row.preview, displayMode).join('\n') })),
    [displayMode, rows]
  );

  useImperativeHandle(
    controlRef,
    () => ({
      scrollToTop: (behavior = 'auto') => {
        const scroller = scrollerRef.current;
        if (!scroller) return;
        if (behavior === 'auto') scroller.scrollTop = 0;
        else scroller.scrollTo({ behavior, top: 0 });
      },
      scrollToBottom: (behavior = 'auto') => {
        const scroller = scrollerRef.current;
        if (!scroller) return;
        pinnedRef.current = true;
        const top = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        if (behavior === 'auto') scroller.scrollTop = top;
        else scroller.scrollTo({ behavior, top });
      }
    }),
    []
  );

  const firstKey = cards[0]?.row.identity ?? null;
  const lastKey = cards.at(-1)?.row.identity ?? null;
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const previous = previousLayoutRef.current;
    if (previous.firstKey && firstKey && previous.firstKey !== firstKey && !pinnedRef.current) {
      scroller.scrollTop += scroller.scrollHeight - previous.height;
    } else if (pinnedRef.current && lastKey) {
      scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    }
    previousLayoutRef.current = { firstKey, height: scroller.scrollHeight };
  }, [firstKey, lastKey]);

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
  return (
    <div
      className="scwf-scroll monad-selectable"
      data-observation-raw="list"
      onScroll={(event) => {
        const scroller = event.currentTarget;
        pinnedRef.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 32;
        const atStart = scroller.scrollTop <= 240;
        if (atStart && startArmedRef.current && canLoadOlderEvents && !loadingOlderEvents) {
          startArmedRef.current = false;
          onLoadOlderEvents?.();
        } else if (!atStart) {
          startArmedRef.current = true;
        }
      }}
      ref={scrollerRef}
      role="log"
      style={{
        boxSizing: 'border-box',
        display: 'grid',
        alignContent: 'start',
        gap: 8,
        height: '100%',
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        padding: '12px 14px 62px',
        width: '100%'
      }}
    >
      <div
        data-events-state={loadingOlderEvents ? 'loading' : canLoadOlderEvents ? 'more' : 'start'}
        style={{
          color: 'var(--muted-foreground)',
          fontFamily: sans,
          fontSize: 11,
          padding: '0 0 10px',
          textAlign: 'center'
        }}
      >
        {loadingOlderEvents
          ? 'Loading earlier events…'
          : canLoadOlderEvents
            ? 'Scroll up for earlier events'
            : 'Start of events'}
      </div>
      {cards.map(({ row, text }) => (
        <div
          data-observation-raw-row={row.cursor}
          data-raw-card-id={row.identity}
          key={row.identity}
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
              title={row.cursor || row.identity}
            >
              {row.cursor || row.identity}
            </span>
          </div>
          <div
            style={{
              maxHeight: 256,
              minWidth: 0,
              overflow: 'auto'
            }}
          >
            <CodeBlock
              className="rounded-none border-0 bg-transparent [&>div]:overflow-visible [&_pre]:p-3 [&_pre]:text-xs [&_pre]:leading-relaxed"
              code={text}
              language="json"
            />
          </div>
        </div>
      ))}
    </div>
  );
}
