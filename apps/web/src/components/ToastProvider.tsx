'use client';

import {
  AlertCircleIcon,
  Cancel01Icon,
  CheckIcon,
  CheckmarkCircle02Icon,
  ChevronDownIcon,
  ChevronUpIcon,
  Copy01Icon,
  InformationCircleIcon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button, cn } from '@monad/ui';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useT } from '#/components/I18nProvider';

type ToastVariant = 'success' | 'error' | 'info';

interface ToastInput {
  message: string;
  variant?: ToastVariant;
  duration?: number;
  /** Raw payload shown in the expandable detail panel. */
  detail?: unknown;
  action?: {
    label: string;
    onClick: () => boolean | undefined | Promise<boolean | undefined>;
  };
}

interface ToastItem {
  id: string;
  message: string;
  variant: ToastVariant;
  duration: number;
  detail?: ToastInput['detail'];
  action?: ToastInput['action'];
}

interface ToastRecord extends ToastItem {
  state: 'closing' | 'open';
}

type ToastListener = (toast: ToastRecord) => void;
type ToastCloseListener = (id: string) => void;

const TOAST_EXIT_MS = 180;
const CARD_GAP = 10;
const CARD_HEIGHT_FALLBACK = 64;

const listeners = new Set<ToastListener>();
const closeListeners = new Set<ToastCloseListener>();
const queued: ToastRecord[] = [];
const queuedCloses: string[] = [];

function createToast(input: ToastInput): ToastItem {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
    message: input.message,
    variant: input.variant ?? 'info',
    duration: input.duration ?? 4200,
    detail: input.detail,
    action: input.action
  };
}

function publish(input: ToastInput): string {
  const item: ToastRecord = { ...createToast(input), state: 'open' };
  if (listeners.size === 0) {
    queued.push(item);
    return item.id;
  }
  for (const listener of listeners) listener(item);
  return item.id;
}

function dismiss(id: string): void {
  if (closeListeners.size === 0) {
    queuedCloses.push(id);
    return;
  }
  for (const listener of closeListeners) listener(id);
}

export const toast = {
  info: (message: string, options?: Omit<ToastInput, 'message' | 'variant'>) =>
    publish({ ...options, message, variant: 'info' }),
  success: (message: string, options?: Omit<ToastInput, 'message' | 'variant'>) =>
    publish({ ...options, message, variant: 'success' }),
  error: (message: string, options?: Omit<ToastInput, 'message' | 'variant'>) =>
    publish({ ...options, message, variant: 'error' }),
  dismiss
};

// --- JSON syntax highlighting ---

type TokenType = 'key' | 'string' | 'number' | 'boolean' | 'null' | 'plain';

const TOKEN_RE =
  /((?:"(?:[^"\\]|\\.)*")(?=\s*:))|("(?:[^"\\]|\\.)*")|(true|false)|(null)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

const TOKEN_CLASSES: Record<TokenType, string> = {
  key: 'text-blue-700 dark:text-blue-300',
  string: 'text-emerald-700 dark:text-emerald-300',
  number: 'text-orange-700 dark:text-orange-300',
  boolean: 'text-amber-700 dark:text-amber-300',
  null: 'italic text-muted-foreground',
  plain: 'text-muted-foreground'
};

function JsonHighlight({ value }: { value: unknown }) {
  const json = JSON.stringify(value, null, 2);
  const nodes: React.ReactNode[] = [];
  TOKEN_RE.lastIndex = 0;
  let last = 0;
  let i = 0;

  for (let m = TOKEN_RE.exec(json); m !== null; m = TOKEN_RE.exec(json)) {
    if (m.index > last)
      nodes.push(
        <span
          className={TOKEN_CLASSES.plain}
          key={i++}
        >
          {json.slice(last, m.index)}
        </span>
      );
    const [, key, str, bool, nil, _num] = m;
    const type: TokenType =
      key !== undefined
        ? 'key'
        : str !== undefined
          ? 'string'
          : bool !== undefined
            ? 'boolean'
            : nil !== undefined
              ? 'null'
              : 'number';
    nodes.push(
      <span
        className={TOKEN_CLASSES[type]}
        key={i++}
      >
        {m[0]}
      </span>
    );
    last = m.index + m[0].length;
  }
  if (last < json.length)
    nodes.push(
      <span
        className={TOKEN_CLASSES.plain}
        key={i}
      >
        {json.slice(last)}
      </span>
    );

  return <>{nodes}</>;
}

// --- Copy button with flash ---

function CopyButton({ text }: { text: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <button
      className="absolute top-2 right-2 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      onClick={handleCopy}
      title={t('web.copy')}
      type="button"
    >
      {copied ? (
        <HugeiconsIcon
          className="size-3.5 text-emerald-400"
          icon={CheckIcon}
        />
      ) : (
        <HugeiconsIcon
          className="size-3.5"
          icon={Copy01Icon}
        />
      )}
    </button>
  );
}

// --- Detail panel ---

function DetailPanel({ detail }: { detail: unknown }) {
  const isObj = detail !== null && typeof detail === 'object';
  const text = isObj ? JSON.stringify(detail, null, 2) : String(detail);

  return (
    <div className="relative mt-1.5">
      <pre className="max-h-36 overflow-auto rounded-md border border-border bg-popover p-2.5 pr-8 font-mono text-[11px] text-popover-foreground leading-relaxed shadow-xs">
        {isObj ? <JsonHighlight value={detail} /> : <span className="text-popover-foreground">{text}</span>}
      </pre>
      <CopyButton text={text} />
    </div>
  );
}

// --- Toast icon ---

function ToastIcon({ variant }: { variant: ToastVariant }) {
  if (variant === 'success')
    return (
      <HugeiconsIcon
        className="mt-0.5 size-4 shrink-0 text-success"
        icon={CheckmarkCircle02Icon}
      />
    );
  if (variant === 'error')
    return (
      <HugeiconsIcon
        className="mt-0.5 size-4 shrink-0 text-destructive"
        icon={AlertCircleIcon}
      />
    );
  return (
    <HugeiconsIcon
      className="mt-0.5 size-4 shrink-0 text-info"
      icon={InformationCircleIcon}
    />
  );
}

// --- Expandable message row ---

function ExpandableMessage({
  detail,
  expanded,
  message,
  onToggle
}: {
  detail: unknown;
  expanded: boolean;
  message: string;
  onToggle: () => void;
}) {
  const t = useT();
  const hasDetail = detail !== undefined;
  return (
    <div className="flex items-baseline justify-between gap-2">
      <p className="line-clamp-2 min-w-0 flex-1 break-words text-[13px] leading-5">{message}</p>
      {hasDetail && (
        <button
          className="ml-1 flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          onClick={onToggle}
          type="button"
        >
          {expanded ? (
            <HugeiconsIcon
              className="size-3"
              icon={ChevronUpIcon}
            />
          ) : (
            <HugeiconsIcon
              className="size-3"
              icon={ChevronDownIcon}
            />
          )}
          {expanded ? t('web.toast.collapse') : t('web.toast.expand')}
        </button>
      )}
    </div>
  );
}

// --- Toast card ---

function ToastCard({
  item,
  fromFront,
  hovered,
  expandedOffset,
  onClose,
  onMeasure
}: {
  item: ToastRecord;
  fromFront: number;
  hovered: boolean;
  expandedOffset: number;
  onClose: (id: string) => void;
  onMeasure: (id: string, height: number) => void;
}) {
  const t = useT();
  const [entered, setEntered] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // Pause auto-dismiss while the detail panel is open.
  useEffect(() => {
    if (item.state !== 'open' || expanded) return;
    if (!Number.isFinite(item.duration)) return;
    const timer = window.setTimeout(() => onClose(item.id), item.duration);
    return () => window.clearTimeout(timer);
  }, [item.duration, item.id, item.state, onClose, expanded]);

  // Initial measurement on mount.
  const measureRef = useCallback(
    (node: HTMLDivElement | null) => {
      cardRef.current = node;
      if (node) onMeasure(item.id, node.offsetHeight);
    },
    [item.id, onMeasure]
  );

  // Re-measure after expand/collapse so the container grows/shrinks.
  // biome-ignore lint/correctness/useExhaustiveDependencies: expanded intentionally retriggers measurement.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      if (cardRef.current) onMeasure(item.id, cardRef.current.offsetHeight);
    });
    return () => cancelAnimationFrame(raf);
  }, [expanded, item.id, onMeasure]);

  const isHidden = fromFront >= 3;
  const isClosing = item.state === 'closing';
  const hasDetail = item.detail !== undefined;

  const stackedY = fromFront * 8;
  const stackedScale = 1 - fromFront * 0.05;

  const transform = isClosing
    ? 'translateY(-6px) scale(0.97)'
    : !entered
      ? 'translateY(-10px) scale(0.98)'
      : hovered
        ? `translateY(${expandedOffset}px) scale(1)`
        : `translateY(${stackedY}px) scale(${stackedScale})`;

  const opacity =
    isClosing || !entered ? 0 : isHidden ? 0 : hovered ? 1 : fromFront === 0 ? 1 : fromFront === 1 ? 0.8 : 0.62;

  const handleAction = async () => {
    if (!item.action || actionLoading) return;
    setActionLoading(true);
    try {
      const shouldClose = await item.action.onClick();
      if (shouldClose !== false) onClose(item.id);
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <div
      aria-hidden={isHidden ? true : undefined}
      className={cn(
        'glass-surface pointer-events-auto absolute right-0 left-0 grid origin-top grid-cols-[1rem_minmax(0,1fr)] items-start gap-2.5 px-3 py-3 pr-10 text-popover-foreground shadow-lg',
        'transition-[transform,opacity] ease-[cubic-bezier(0.32,0.72,0,1)]',
        isClosing ? 'duration-[180ms]' : 'duration-300',
        item.variant === 'error' && 'border-destructive/35',
        item.variant === 'success' && 'border-success/35'
      )}
      ref={measureRef}
      role={item.variant === 'error' ? 'alert' : 'status'}
      style={{
        transform,
        opacity,
        zIndex: 50 - fromFront,
        pointerEvents: isHidden ? 'none' : undefined
      }}
    >
      <ToastIcon variant={item.variant} />

      <div className="min-w-0">
        <ExpandableMessage
          detail={item.detail}
          expanded={expanded}
          message={item.message}
          onToggle={() => setExpanded((v) => !v)}
        />
        {expanded && hasDetail && <DetailPanel detail={item.detail} />}
        {item.action ? (
          <Button
            className="mt-2 h-7 px-2 text-xs"
            disabled={actionLoading}
            onClick={() => void handleAction()}
            size="sm"
          >
            {item.action.label}
          </Button>
        ) : null}
      </div>

      <Button
        aria-label={t('web.toast.dismiss')}
        className="absolute top-2 right-2 size-7"
        onClick={() => onClose(item.id)}
        size="icon"
        variant="ghost"
      >
        <HugeiconsIcon
          className="size-3.5"
          icon={Cancel01Icon}
        />
      </Button>
    </div>
  );
}

// --- Provider ---

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const t = useT();
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const [hovered, setHovered] = useState(false);
  const [heights, setHeights] = useState<Record<string, number>>({});

  const removeToast = useCallback((id: string) => {
    setToasts((current) => current.filter((item) => item.id !== id));
    setHeights((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const closeToast = useCallback(
    (id: string) => {
      setToasts((current) =>
        current.map((item) => (item.id === id && item.state === 'open' ? { ...item, state: 'closing' } : item))
      );
      window.setTimeout(() => removeToast(id), TOAST_EXIT_MS);
    },
    [removeToast]
  );

  const handleMeasure = useCallback((id: string, height: number) => {
    setHeights((prev) => (prev[id] === height ? prev : { ...prev, [id]: height }));
  }, []);

  useEffect(() => {
    const listener: ToastListener = (item) => {
      setToasts((current) => [...current, item].slice(-4));
    };
    listeners.add(listener);
    for (const item of queued.splice(0)) listener(item);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    closeListeners.add(closeToast);
    for (const id of queuedCloses.splice(0)) closeToast(id);
    return () => {
      closeListeners.delete(closeToast);
    };
  }, [closeToast]);

  const expandedOffsets: number[] = new Array(toasts.length).fill(0);
  let cumulative = 0;
  for (let i = toasts.length - 1; i >= 0; i--) {
    expandedOffsets[i] = cumulative;
    cumulative += (heights[toasts[i].id] ?? CARD_HEIGHT_FALLBACK) + CARD_GAP;
  }

  const frontToast = toasts[toasts.length - 1];
  const frontHeight = frontToast ? (heights[frontToast.id] ?? CARD_HEIGHT_FALLBACK) : 0;
  const visibleBehind = Math.min(Math.max(toasts.length - 1, 0), 2);
  const stackedHeight = frontHeight + visibleBehind * 8;
  const expandedHeight = cumulative > 0 ? cumulative - CARD_GAP : 0;
  const containerHeight = toasts.length === 0 ? 0 : hovered ? expandedHeight : stackedHeight;

  return (
    <>
      {children}
      <section
        aria-label={t('web.toast.notifications')}
        aria-live="polite"
        aria-relevant="additions text"
        className="fixed top-4 left-1/2 z-50 w-[min(390px,calc(100vw-2rem))] -translate-x-1/2"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          height: containerHeight,
          pointerEvents: toasts.length > 0 ? 'auto' : 'none'
        }}
      >
        {toasts.map((item, index) => (
          <ToastCard
            expandedOffset={expandedOffsets[index]}
            fromFront={toasts.length - 1 - index}
            hovered={hovered}
            item={item}
            key={item.id}
            onClose={closeToast}
            onMeasure={handleMeasure}
          />
        ))}
      </section>
    </>
  );
}
