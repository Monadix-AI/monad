import type { Ref } from 'react';
import type { RawDisplayMode, RawFrameRow } from './raw-view.ts';

import { CheckIcon, Copy01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { uiFontFamily as uiFont } from '@monad/ui/components/AgentAvatar';
import { AnsiText, hasAnsiSgr, parseAnsiText } from '@monad/ui/components/AnsiText';
import { Button } from '@monad/ui/components/Button';
import { CodeBlock } from '@monad/ui/components/CodeBlock';
import { Tooltip, TooltipContent, TooltipTrigger } from '@monad/ui/components/Tooltip';
import { VirtualList, type VirtualListHandle } from '@monad/ui/components/VirtualList';
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';

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

function RawObservationCopyButton({ text }: { text: string }): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number>(0);
  const label = copied ? 'Copied' : 'Copy raw event';

  const copy = useCallback(async () => {
    if (typeof navigator === 'undefined' || typeof navigator.clipboard?.writeText !== 'function') return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }, [text]);

  useEffect(
    () => () => {
      window.clearTimeout(timeoutRef.current);
    },
    []
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
          data-observation-raw-copy={copied ? 'copied' : 'idle'}
          onClick={(event) => {
            event.stopPropagation();
            void copy();
          }}
          size="icon-sm"
          title={label}
          type="button"
          variant="ghost"
        >
          <HugeiconsIcon
            aria-hidden="true"
            icon={copied ? CheckIcon : Copy01Icon}
            size={13}
          />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export interface RawVirtualListControlProps {
  getKey: (card: RawDisplayCard) => string;
  items: RawDisplayCard[];
  onStartReached: () => boolean;
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
      if (args.loadingOlderEvents) return false;
      if (!args.canLoadOlderEvents) return false;
      args.onLoadOlderEvents?.();
      return true;
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
  const ansiSegments = useMemo(() => parseAnsiText(text, undefined, 'adaptive'), [text]);
  const hasAnsi = hasAnsiSgr(text);
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
            fontFamily: uiFont,
            fontSize: 10,
            fontWeight: 700,
            textTransform: 'uppercase'
          }}
        >
          {STREAM_LABEL[row.stream]}
        </span>
        <div
          style={{
            alignItems: 'center',
            display: 'flex',
            flex: '1 1 auto',
            gap: 6,
            justifyContent: 'flex-end',
            minWidth: 0
          }}
        >
          <span
            style={{
              color: 'var(--muted-foreground)',
              fontFamily: uiFont,
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
          <RawObservationCopyButton text={text} />
        </div>
      </div>
      {displayMode === 'parsed' && !hasAnsi ? (
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
            fontFamily: uiFont,
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
          <AnsiText segments={ansiSegments} />
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
  const cards = useMemo<RawDisplayCard[]>(
    () => rows.map((row) => ({ row, text: rawDisplayEntries(row.preview, displayMode).join('\n') })),
    [displayMode, rows]
  );

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
          fontFamily: uiFont,
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
        fontFamily: uiFont,
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
    <div style={{ height: '100%', minHeight: 0, width: '100%' }}>
      <VirtualList
        {...rawVirtualListControlProps({
          cards,
          canLoadOlderEvents,
          loadingOlderEvents,
          onLoadOlderEvents
        })}
        ariaLive="polite"
        autoLoadStartWhenUnderfilled={{ canLoad: canLoadOlderEvents, loading: loadingOlderEvents }}
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
