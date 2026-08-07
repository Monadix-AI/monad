import type { BrandGlyphIcon } from './BrandGlyph';

import { useCallback, useRef, useState } from 'react';

import { cn } from '../lib/utils';
import { BrandGlyph } from './BrandGlyph';
import { Popover, PopoverContent, PopoverTrigger } from './Popover';

export interface ChannelOriginDetail {
  label: string;
  value: string;
}

/**
 * Ingress provenance as this package needs to read it. Structural (not imported from the data
 * layer) so both chat surfaces can pass their own origin objects unchanged.
 */
export interface ChannelOriginView {
  transport: string;
  surface?: string;
  client?: string;
  clientVersion?: string;
  instanceId?: string;
  senderId?: string;
  senderDisplay?: string;
  chatTitle?: string;
  chatType?: 'dm' | 'group' | 'channel';
  threadId?: string;
}

export interface ChannelOriginLabels {
  conversation: string;
  directMessage: string;
  group: string;
  channel: string;
  sender: string;
  thread: string;
  instance: string;
  version: string;
}

/** A message shows its origin only when it came from somewhere other than this web app — a badge
 *  reading "sent from web" on every web message is noise, and a bare transport names nothing. */
export function showsChannelOrigin(origin: ChannelOriginView | undefined): origin is ChannelOriginView {
  return Boolean(origin && origin.surface !== 'web' && origin.client);
}

/**
 * The readable rows behind the badge. Prefers what a human recognizes (conversation title, sender
 * name) and falls back to platform ids only when the adapter reported nothing better.
 */
export function channelOriginDetails(origin: ChannelOriginView, labels: ChannelOriginLabels): ChannelOriginDetail[] {
  const conversationKind =
    origin.chatType === 'dm'
      ? labels.directMessage
      : origin.chatType === 'group'
        ? labels.group
        : origin.chatType === 'channel'
          ? labels.channel
          : undefined;
  const conversation = origin.chatTitle
    ? conversationKind
      ? `${origin.chatTitle} · ${conversationKind}`
      : origin.chatTitle
    : conversationKind;
  const sender = origin.senderDisplay ?? origin.senderId;
  return [
    ...(conversation ? [{ label: labels.conversation, value: conversation }] : []),
    ...(sender ? [{ label: labels.sender, value: sender }] : []),
    ...(origin.threadId ? [{ label: labels.thread, value: origin.threadId }] : []),
    ...(origin.instanceId ? [{ label: labels.instance, value: origin.instanceId }] : []),
    ...(origin.clientVersion ? [{ label: labels.version, value: origin.clientVersion }] : [])
  ];
}

/** How long the popover survives the pointer leaving, so it can be crossed into. */
const CLOSE_GRACE_MS = 120;

/**
 * A message's delivery provenance, compressed to the source platform's mark. Hovering (or
 * focusing) the mark opens the readable detail — conversation, sender, thread — so the transcript
 * itself stays free of provenance text.
 *
 * Presentation only: callers pass an already-resolved brand mark and already-localized rows.
 */
export function ChannelOriginBadge({
  ariaLabel,
  className,
  details,
  icon,
  name,
  size = 14
}: {
  /** Accessible name for the trigger, e.g. "Sent from Slack". */
  ariaLabel: string;
  className?: string;
  details: readonly ChannelOriginDetail[];
  /** The channel's brand mark; absent when the atom pack that owns it is not installed. */
  icon?: BrandGlyphIcon;
  /** Display name of the source channel, shown as the popover heading. */
  name: string;
  size?: number;
}) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);
  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_GRACE_MS);
  }, [cancelClose]);
  const openNow = useCallback(() => {
    cancelClose();
    setOpen(true);
  }, [cancelClose]);

  return (
    <Popover
      onOpenChange={setOpen}
      open={open}
    >
      <PopoverTrigger
        aria-label={ariaLabel}
        className={cn(
          'inline-flex items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          className
        )}
        onClick={() => setOpen((current) => !current)}
        onPointerEnter={openNow}
        onPointerLeave={scheduleClose}
        type="button"
      >
        {icon ? (
          <BrandGlyph
            icon={icon}
            style={{ height: size, width: size }}
          />
        ) : (
          // No installed pack owns this channel type: fall back to a neutral mark rather than
          // dropping the badge — the provenance is still worth surfacing.
          <span
            aria-hidden="true"
            className="rounded-full bg-current"
            style={{ height: size * 0.55, width: size * 0.55 }}
          />
        )}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-auto min-w-56 max-w-72 p-3"
        // Radix moves focus into the content on open and back to the trigger on close. With a
        // hover-driven popover that return trip re-enters the trigger under the pointer's old
        // position and reopens it — an open/close flicker loop. Keeping focus put breaks the loop;
        // the trigger stays keyboard-operable because clicking (Enter/Space) toggles it.
        onCloseAutoFocus={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={openNow}
        onPointerLeave={scheduleClose}
        side="top"
      >
        <div className="flex items-center gap-2 pb-2">
          {icon ? (
            <BrandGlyph
              icon={icon}
              style={{ height: 16, width: 16 }}
            />
          ) : null}
          <span className="font-medium text-sm capitalize">{name}</span>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {details.map((detail) => (
            <div
              className="contents"
              key={detail.label}
            >
              <dt className="text-muted-foreground">{detail.label}</dt>
              <dd className="wrap-break-word text-foreground/90">{detail.value}</dd>
            </div>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  );
}
