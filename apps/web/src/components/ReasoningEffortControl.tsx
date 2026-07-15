import type { CSSProperties, ReactNode } from 'react';

import { BrainIcon, EnergyIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { cn } from '@monad/ui';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

import { useT } from '#/components/I18nProvider';

export interface ReasoningEffortOption {
  value?: string;
  label?: ReactNode;
}

function formatEffortLabel(value: string | undefined): string {
  if (!value) return '';
  return value
    .split(/([-_])/)
    .map((part) => (part === '-' || part === '_' ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
}

export function reasoningEffortOption(value: string): ReasoningEffortOption {
  return { value, label: formatEffortLabel(value) };
}

export function resolveReasoningEffort(
  efforts: readonly string[] | undefined,
  ...preferredValues: Array<string | undefined>
): { efforts: string[]; value: string | undefined } {
  const values = [...new Set(efforts?.map((effort) => effort.trim()).filter(Boolean) ?? [])];
  return {
    efforts: values,
    value: preferredValues.find((value): value is string => !!value && values.includes(value))
  };
}

export function deferredEffortCommit(
  open: boolean,
  current: string | undefined,
  draft: string | undefined
): { value: string | undefined } | null {
  return !open && current !== draft ? { value: draft } : null;
}

function clampIndex(value: number, length: number): number {
  return Math.min(Math.max(Math.round(value), 0), Math.max(0, length - 1));
}

const THUMB_WIDTH_PX = 18;
const TRACK_BORDER_PX = 0.5;

function positionFromPointer(clientX: number, rect: DOMRect, maxIndex: number): number {
  if (maxIndex <= 0) return 0;
  const thumbHalf = THUMB_WIDTH_PX / 2;
  const span = Math.max(1, rect.width - THUMB_WIDTH_PX);
  const center = Math.min(Math.max(clientX - rect.left, thumbHalf), rect.width - thumbHalf);
  return ((center - thumbHalf) / span) * maxIndex;
}

function thumbCenterStyle(ratio: number): string {
  return `calc(${ratio} * (100% - ${THUMB_WIDTH_PX}px) + ${THUMB_WIDTH_PX / 2}px)`;
}

function EffortValueText({ direction, title, titleKey }: { direction: number; title: ReactNode; titleKey: string }) {
  const variants = {
    initial: (customDirection: number) => ({
      opacity: 0,
      y: customDirection >= 0 ? '75%' : '-75%'
    }),
    animate: {
      opacity: 1,
      y: 0
    },
    exit: (customDirection: number) => ({
      opacity: 0,
      y: customDirection >= 0 ? '-75%' : '75%'
    })
  };

  return (
    <span className="relative inline-flex h-5 w-[9ch] items-center overflow-hidden align-middle leading-none">
      <AnimatePresence
        custom={direction}
        initial={false}
      >
        <motion.span
          animate="animate"
          className="absolute inset-0 flex items-center truncate font-medium text-foreground"
          custom={direction}
          exit="exit"
          initial="initial"
          key={titleKey}
          transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
          variants={variants}
        >
          {title}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

export function ReasoningEffortControl({
  options,
  value,
  onChange,
  defaultLabel,
  className,
  compact = false,
  surface = 'card'
}: {
  options: ReasoningEffortOption[];
  value?: string;
  onChange: (value: string | undefined) => void;
  defaultLabel?: string;
  className?: string;
  compact?: boolean;
  surface?: 'card' | 'plain';
}) {
  const t = useT();
  const sliderOptions = options;
  const activeIndex = sliderOptions.findIndex((option) => option.value === value);
  const sliderIndex = activeIndex >= 0 ? activeIndex : 0;
  const maxIndex = Math.max(0, sliderOptions.length - 1);
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const [sliderPosition, setSliderPosition] = useState(sliderIndex);
  const [interacting, setInteracting] = useState(false);
  const [pendingValue, setPendingValue] = useState<{ value: string | undefined } | null>(null);
  const previewIndex = interacting || activeIndex >= 0 ? clampIndex(sliderPosition, sliderOptions.length) : -1;
  const previousPreviewIndexRef = useRef(previewIndex);
  const titleDirection = previewIndex >= previousPreviewIndexRef.current ? 1 : -1;
  const previewOption = previewIndex >= 0 ? sliderOptions[previewIndex] : undefined;
  const title = previewOption?.label ?? (value ? formatEffortLabel(value) : defaultLabel);
  const titleKey = previewOption?.value ?? String(title);
  const boundedPosition = Math.min(Math.max(sliderPosition, 0), maxIndex);
  const progressRatio = maxIndex > 0 ? boundedPosition / maxIndex : 0;
  const progressWidth =
    progressRatio <= 0
      ? '0px'
      : `calc(${progressRatio} * (100% - ${THUMB_WIDTH_PX}px) + ${THUMB_WIDTH_PX - TRACK_BORDER_PX * 2}px)`;

  const updateFromPointer = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return;
    setSliderPosition(positionFromPointer(clientX, rect, maxIndex));
  };

  const commitPosition = (position: number) => {
    const index = clampIndex(position, sliderOptions.length);
    const next = sliderOptions[index];
    draggingRef.current = false;
    setInteracting(false);
    setSliderPosition(index);
    if (next?.value !== value) {
      setPendingValue({ value: next?.value });
      onChange(next?.value);
    }
  };

  useEffect(() => {
    if (pendingValue && value !== pendingValue.value) return;
    if (pendingValue && value === pendingValue.value) setPendingValue(null);
    if (!interacting) setSliderPosition(sliderIndex);
  }, [interacting, pendingValue, sliderIndex, value]);

  useEffect(() => {
    previousPreviewIndexRef.current = previewIndex;
  }, [previewIndex]);

  if (options.length === 0) return null;

  return (
    <div
      className={cn(
        'min-w-0',
        surface === 'card' && 'rounded-lg border border-border/70 bg-card p-3 shadow-sm',
        surface === 'card' && compact && 'p-2.5',
        className
      )}
      style={
        {
          '--effort-fill-end': 'color-mix(in oklab, var(--foreground) 82%, var(--muted-foreground))',
          '--effort-fill-start': 'color-mix(in oklab, var(--foreground) 58%, var(--muted-foreground))',
          '--effort-thumb': 'color-mix(in srgb, var(--card) 88%, var(--foreground) 12%)',
          '--effort-track-end': 'color-mix(in srgb, var(--muted) 70%, var(--background))',
          '--effort-track-start': 'color-mix(in srgb, var(--muted) 84%, var(--card))'
        } as CSSProperties
      }
    >
      <div className="flex items-center justify-between gap-3">
        <div className="inline-flex min-w-0 items-center gap-1 text-sm">
          <span className="text-muted-foreground">{t('web.reasoning.effort')}</span>
          <EffortValueText
            direction={titleDirection}
            title={title}
            titleKey={titleKey}
          />
        </div>
      </div>
      <div className="relative mt-2">
        <div
          aria-label={t('web.reasoning.effort')}
          aria-orientation="horizontal"
          aria-valuemax={maxIndex}
          aria-valuemin={0}
          aria-valuenow={previewIndex >= 0 ? previewIndex : 0}
          aria-valuetext={
            previewOption ? String(previewOption.label ?? formatEffortLabel(previewOption.value)) : defaultLabel
          }
          className={cn(
            'relative h-7 cursor-ew-resize touch-none select-none rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring',
            compact && 'h-6'
          )}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
              event.preventDefault();
              commitPosition(Math.max(0, clampIndex(sliderPosition, sliderOptions.length) - 1));
            } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
              event.preventDefault();
              commitPosition(Math.min(maxIndex, clampIndex(sliderPosition, sliderOptions.length) + 1));
            } else if (event.key === 'Home') {
              event.preventDefault();
              commitPosition(0);
            } else if (event.key === 'End') {
              event.preventDefault();
              commitPosition(maxIndex);
            }
          }}
          onPointerCancel={() => commitPosition(sliderPosition)}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            draggingRef.current = true;
            setInteracting(true);
            updateFromPointer(event.clientX);
          }}
          onPointerMove={(event) => {
            if (draggingRef.current) updateFromPointer(event.clientX);
          }}
          onPointerUp={(event) => {
            updateFromPointer(event.clientX);
            const rect = trackRef.current?.getBoundingClientRect();
            const position = rect ? positionFromPointer(event.clientX, rect, maxIndex) : sliderPosition;
            commitPosition(position);
          }}
          ref={trackRef}
          role="slider"
          tabIndex={0}
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 z-40 text-muted-foreground"
          >
            <HugeiconsIcon
              className={cn(
                'absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 transition-colors duration-150 ease-out',
                progressRatio > 0 ? 'text-background/90' : 'text-muted-foreground'
              )}
              icon={EnergyIcon}
              style={{ left: `${THUMB_WIDTH_PX / 2}px` }}
            />
            <HugeiconsIcon
              className={cn(
                'absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 transition-colors duration-150 ease-out',
                progressRatio >= 1 ? 'text-background/90' : 'text-muted-foreground'
              )}
              icon={BrainIcon}
              style={{ left: `calc(100% - ${THUMB_WIDTH_PX / 2}px)` }}
            />
          </div>
          <div
            aria-hidden="true"
            className="absolute inset-0 rounded-[11px]"
            style={{
              background: 'linear-gradient(180deg, var(--effort-track-start), var(--effort-track-end))',
              border: '0.5px solid color-mix(in srgb, var(--foreground) 14%, var(--border))',
              boxShadow:
                'inset 0 1px 0 color-mix(in srgb, var(--foreground) 7%, transparent), 0 1px 2px rgb(0 0 0 / 0.12)'
            }}
          />
          <div
            aria-hidden="true"
            className={cn(
              'absolute inset-y-[0.5px] left-[0.5px] overflow-hidden rounded-[10.5px]',
              !interacting && 'transition-[width,opacity] duration-150 ease-out'
            )}
            style={{
              background: 'linear-gradient(90deg, var(--effort-fill-start), var(--effort-fill-end))',
              boxShadow: 'inset 0 1px 0 color-mix(in srgb, white 24%, transparent)',
              opacity: progressRatio <= 0 ? 0 : 1,
              width: progressWidth
            }}
          />
          {sliderOptions.slice(1, -1).map((option, index) => {
            const optionIndex = index + 1;
            return (
              <span
                aria-hidden="true"
                className={cn(
                  'pointer-events-none absolute top-1/2 z-20 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors duration-200',
                  optionIndex <= previewIndex ? 'bg-background/90' : 'bg-muted-foreground/45'
                )}
                key={option.value}
                style={{ left: thumbCenterStyle(optionIndex / maxIndex) }}
              />
            );
          })}
          <span
            aria-hidden="true"
            className={cn(
              'absolute inset-y-0 z-30 w-[18px] -translate-x-1/2 rounded-[10.5px] transition-[background-color,border-color,box-shadow] duration-150 ease-out',
              interacting && 'brightness-110'
            )}
            style={{
              background:
                'linear-gradient(180deg, color-mix(in srgb, white 8%, var(--effort-thumb)), var(--effort-thumb))',
              border: '0.5px solid color-mix(in srgb, var(--foreground) 18%, var(--border))',
              boxShadow: '0 2px 8px rgb(0 0 0 / 0.18), inset 0 1px 0 color-mix(in srgb, white 18%, transparent)',
              left: thumbCenterStyle(progressRatio)
            }}
          />
        </div>
        <div className="mt-1 flex items-center justify-between px-0.5 text-[11px] text-muted-foreground leading-none">
          <span>{t('web.reasoning.fast')}</span>
          <span>{t('web.reasoning.smart')}</span>
        </div>
      </div>
    </div>
  );
}
