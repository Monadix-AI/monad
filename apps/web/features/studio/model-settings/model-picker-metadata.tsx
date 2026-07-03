'use client';

import type { ModelInfo, ModelPrice } from '@monad/protocol';

import {
  ArrowRight01Icon,
  ArrowUpDownIcon,
  AudioWaveformIcon,
  BadgeDollarSignIcon,
  BookOpenTextIcon,
  BrainIcon,
  CaptionsIcon,
  DatabaseIcon,
  ExternalLinkIcon,
  Image01Icon,
  TextIcon,
  TypeCursorIcon,
  VideoIcon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { cn, Tooltip, TooltipContent, TooltipTrigger } from '@monad/ui';

import { useT } from '@/components/I18nProvider';

function formatContextLimit(limit: number): string {
  return `${Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(limit)}`;
}

function formatPriceValue(value: number | undefined): string {
  if (value === undefined) return 'N/A';
  const maximumFractionDigits = value > 0 && value < 0.0001 ? 8 : 4;
  return `$${value.toLocaleString('en-US', { maximumFractionDigits })}`;
}

type PriceDisplayItem = { label: string; price: number; unit: string };

function formatUnitPrice(item: PriceDisplayItem): string {
  const unit = item.unit === 'second' ? 'seconds' : item.unit;
  return `${formatPriceValue(item.price)}/${unit}`;
}

function priceDisplayItems(price: ModelPrice | undefined): PriceDisplayItem[] {
  if (!price) return [];
  if (price.units?.length) return price.units;
  return [
    price.input !== undefined ? { label: 'Input', price: price.input, unit: 'M' } : null,
    price.output !== undefined ? { label: 'Output', price: price.output, unit: 'M' } : null,
    price.cacheRead !== undefined ? { label: 'Cache read', price: price.cacheRead, unit: 'M' } : null,
    price.cacheWrite !== undefined ? { label: 'Cache write', price: price.cacheWrite, unit: 'M' } : null,
    price.videoSecond !== undefined ? { label: 'Video', price: price.videoSecond, unit: 'second' } : null
  ].filter((item): item is PriceDisplayItem => item !== null);
}

function priceSummaryFromItems(items: PriceDisplayItem[]): string {
  if (items.length === 0) return 'N/A';
  if (isTokenPriceSet(items)) return items.map(formatUnitPrice).join(' · ');
  const primary = items.find((item) => item.unit !== 'M') ?? items[0];
  if (!primary) return 'N/A';
  return formatUnitPrice(primary);
}

const TOKEN_PRICE_LABELS = new Set(['Input', 'Output', 'Cache read', 'Cache write']);
const PRIMARY_TOKEN_PRICE_LABELS = new Set(['Input', 'Output']);

function isTokenPriceSet(items: PriceDisplayItem[]): boolean {
  return items.length > 0 && items.every((item) => item.unit === 'M' && TOKEN_PRICE_LABELS.has(item.label));
}

function tokenPriceItems(items: PriceDisplayItem[]): PriceDisplayItem[] {
  return items.filter((item) => item.unit === 'M' && PRIMARY_TOKEN_PRICE_LABELS.has(item.label));
}

function hasNonZeroPrimaryTokenPrice(items: PriceDisplayItem[]): boolean {
  return tokenPriceItems(items).some((item) => item.price !== 0);
}

function primaryPriceItems(price: ModelPrice | undefined): PriceDisplayItem[] {
  const items = priceDisplayItems(price);
  if (hasNonZeroPrimaryTokenPrice(items)) {
    const tokenItems = tokenPriceItems(items);
    if (tokenItems.length > 0) return tokenItems;
  }
  if (isTokenPriceSet(items)) return items;
  const primary = items.find((item) => item.unit !== 'M') ?? items[0];
  return primary ? [primary] : [];
}

function priceSummary(price: ModelPrice | undefined): string {
  return priceSummaryFromItems(primaryPriceItems(price));
}

export function modelPickerPriceSummary(price: ModelPrice | undefined): string {
  return priceSummary(price);
}

function priceTooltip(price: ModelPrice | undefined): React.ReactNode | undefined {
  return priceTooltipFromItems(priceDisplayItems(price));
}

function priceTooltipFromItems(items: PriceDisplayItem[]): React.ReactNode | undefined {
  if (items.length === 0) return undefined;
  return (
    <span className="flex flex-col gap-1">
      {items.map((item) => (
        <span key={`${item.label}-${item.unit}`}>
          {item.label} {formatUnitPrice(item)}
        </span>
      ))}
    </span>
  );
}

function videoPriceItems(price: ModelPrice | undefined): PriceDisplayItem[] {
  return primaryPriceItems(price);
}

function videoPriceTooltip(price: ModelPrice | undefined): React.ReactNode | undefined {
  return priceTooltipFromItems(priceDisplayItems(price));
}

export function ContextLimitTag({
  limit,
  orientation = 'horizontal',
  tooltip = false
}: {
  limit: number;
  orientation?: 'horizontal' | 'vertical';
  tooltip?: boolean;
}) {
  const content = (
    <span
      className={cn(
        'inline-flex text-muted-foreground tabular-nums',
        orientation === 'vertical' ? 'flex-col items-start gap-1' : 'h-4 items-center gap-1'
      )}
    >
      <HugeiconsIcon
        className="size-3 text-muted-foreground/70"
        icon={BookOpenTextIcon}
      />
      {formatContextLimit(limit)}
    </span>
  );
  if (!tooltip) return content;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent>Context window: {limit.toLocaleString('en-US')} tokens</TooltipContent>
    </Tooltip>
  );
}

export function ModelOptionPriceTag({ price }: { price: ModelPrice }) {
  const content = (
    <span className="inline-flex h-4 min-w-0 items-center gap-1 text-muted-foreground tabular-nums">
      <HugeiconsIcon
        className="size-3 text-muted-foreground/70"
        icon={BadgeDollarSignIcon}
      />
      <span className="truncate">{priceSummary(price)}</span>
    </span>
  );
  const tooltip = priceTooltip(price);
  if (!tooltip) return content;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function ModelMetricItem({
  icon: Icon,
  tooltip,
  value
}: {
  icon: IconSvgElement;
  tooltip?: React.ReactNode;
  value: string;
}) {
  const content = (
    <span className="inline-flex min-w-0 flex-col items-start gap-1 text-muted-foreground tabular-nums">
      <HugeiconsIcon
        className="size-3 text-muted-foreground/70"
        icon={Icon}
      />
      <span className="truncate">{value}</span>
    </span>
  );
  if (!tooltip) return content;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

const MODALITY_ICON: Record<string, { icon: IconSvgElement; bg: string; fg: string; label: string }> = {
  text: { icon: TypeCursorIcon, bg: 'bg-cyan-500/20', fg: 'text-cyan-400', label: 'Text' },
  image: { icon: Image01Icon, bg: 'bg-green-500/20', fg: 'text-green-400', label: 'Image' },
  video: { icon: VideoIcon, bg: 'bg-amber-500/20', fg: 'text-amber-400', label: 'Video' },
  audio: { icon: AudioWaveformIcon, bg: 'bg-purple-500/20', fg: 'text-purple-400', label: 'Audio' },
  speech: { icon: AudioWaveformIcon, bg: 'bg-fuchsia-500/20', fg: 'text-fuchsia-400', label: 'Speech' },
  transcription: { icon: CaptionsIcon, bg: 'bg-rose-500/20', fg: 'text-rose-400', label: 'Transcription' },
  rerank: { icon: ArrowUpDownIcon, bg: 'bg-indigo-500/20', fg: 'text-indigo-400', label: 'Rerank' },
  pdf: { icon: TextIcon, bg: 'bg-blue-500/20', fg: 'text-blue-400', label: 'PDF' },
  file: { icon: TextIcon, bg: 'bg-blue-500/20', fg: 'text-blue-400', label: 'File' },
  embedding: { icon: DatabaseIcon, bg: 'bg-muted', fg: 'text-muted-foreground', label: 'Embedding' },
  embeddings: { icon: DatabaseIcon, bg: 'bg-muted', fg: 'text-muted-foreground', label: 'Embeddings' }
};

const MODALITY_FALLBACK = (name: string) => ({
  icon: TextIcon as IconSvgElement,
  bg: 'bg-muted',
  fg: 'text-muted-foreground',
  label: name.charAt(0).toUpperCase() + name.slice(1)
});

const KIND_OUTPUT: Record<string, string[]> = {
  chat: ['text'],
  image: ['image'],
  video: ['video'],
  speech: ['speech'],
  embedding: ['embeddings'],
  audio: ['audio'],
  rerank: ['rerank'],
  transcription: ['transcription']
};

function ModalityBadge({ name }: { name: string }) {
  const meta = MODALITY_ICON[name] ?? MODALITY_FALLBACK(name);
  const Icon = meta.icon;
  return (
    <div className={cn('flex size-6 items-center justify-center rounded-(--radius-sm)', meta.bg)}>
      <HugeiconsIcon
        className={cn('size-3.5', meta.fg)}
        icon={Icon}
      />
    </div>
  );
}

function modalityListLabel(names: string[]): string {
  return names.map((name) => (MODALITY_ICON[name] ?? MODALITY_FALLBACK(name)).label).join(', ');
}

function ModalityGroup({ label, names }: { label: 'Input' | 'Output'; names: string[] }) {
  if (names.length === 0) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          aria-label={`${label}: ${modalityListLabel(names)}`}
          className="flex items-center gap-1"
          role="img"
        >
          {names.map((cap) => (
            <ModalityBadge
              key={`${label}-${cap}`}
              name={cap}
            />
          ))}
        </div>
      </TooltipTrigger>
      <TooltipContent>
        {label}: {modalityListLabel(names)}
      </TooltipContent>
    </Tooltip>
  );
}

export function ModelHoverCardBody({ model }: { model: ModelInfo | undefined }) {
  const t = useT();
  if (!model) return <p className="text-muted-foreground text-xs">{t('web.modelPicker.detailsMissing')}</p>;
  const label = model.label && model.label !== model.id ? model.label : undefined;
  const inputMods = model.modalities?.input ?? [];
  const outputMods =
    model.modalities?.output ?? (model.modalities?.kind ? (KIND_OUTPUT[model.modalities.kind] ?? []) : []);
  const hasModalities = inputMods.length > 0 || outputMods.length > 0;
  const isVideoModel = model.modalities?.kind === 'video' || outputMods.includes('video');
  const videoPrices = videoPriceItems(model.price);
  const isReasoningHiddenModel =
    model.modalities?.kind === 'embedding' ||
    model.modalities?.kind === 'speech' ||
    model.modalities?.kind === 'audio' ||
    model.modalities?.kind === 'rerank' ||
    model.modalities?.kind === 'transcription' ||
    outputMods.some((mod) => mod === 'embeddings' || mod === 'embedding' || mod === 'speech');
  const showReasoningMetric = !isReasoningHiddenModel;
  const reasoningEfforts = model.modalities?.reasoningEfforts?.filter((effort) => effort.trim().length > 0) ?? [];
  const reasoningSupported = reasoningEfforts.length > 0;
  const detailUrl = model.detailUrl ?? model.modelsDevUrl;
  const detailLink = detailUrl ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          aria-label={t('web.modelPicker.seeDetail')}
          className="inline-flex size-5 shrink-0 select-none items-center justify-center rounded-(--radius-sm) text-muted-foreground transition-colors hover:text-foreground"
          draggable={false}
          href={detailUrl}
          onDragStart={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
          rel="noreferrer"
          target="_blank"
        >
          <HugeiconsIcon
            className="size-3"
            icon={ExternalLinkIcon}
          />
        </a>
      </TooltipTrigger>
      <TooltipContent>{t('web.modelPicker.seeDetail')}</TooltipContent>
    </Tooltip>
  ) : null;
  return (
    <div className="flex w-full min-w-0 flex-col gap-0">
      <div className="flex flex-col gap-1 pb-3">
        {label && (
          <div className="flex min-w-0 items-center gap-1.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <p className="min-w-0 flex-1 truncate font-medium text-sm">{label}</p>
              </TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>
            {detailLink}
          </div>
        )}
        <div className="flex min-w-0 items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <p className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground leading-snug">
                {model.id}
              </p>
            </TooltipTrigger>
            <TooltipContent>{model.id}</TooltipContent>
          </Tooltip>
          {!label && detailLink}
        </div>
      </div>
      {isVideoModel ? (
        <div className="flex select-none flex-wrap items-stretch border-border/60 border-t py-2.5 text-[10px] [&>*+*]:border-border/80 [&>*+*]:border-l [&>*:first-child]:pl-0 [&>*]:px-2">
          <span className="inline-flex">
            <ModelMetricItem
              icon={BadgeDollarSignIcon}
              tooltip={videoPriceTooltip(model.price)}
              value={priceSummaryFromItems(videoPrices)}
            />
          </span>
        </div>
      ) : (
        <div className="flex select-none flex-wrap items-stretch border-border/60 border-t py-2.5 text-[10px] [&>*+*]:border-border/80 [&>*+*]:border-l [&>*:first-child]:pl-0 [&>*]:px-2">
          <span className="inline-flex">
            <ModelMetricItem
              icon={BookOpenTextIcon}
              tooltip={
                model.contextLimit ? `Context window: ${model.contextLimit.toLocaleString('en-US')} tokens` : undefined
              }
              value={model.contextLimit ? formatContextLimit(model.contextLimit) : 'N/A'}
            />
          </span>
          {showReasoningMetric && (
            <span className="inline-flex">
              <ModelMetricItem
                icon={BrainIcon}
                tooltip={reasoningSupported ? `Reasoning: ${reasoningEfforts.join(', ')}` : 'Reasoning: No'}
                value={reasoningSupported ? 'Yes' : 'No'}
              />
            </span>
          )}
          <span className="inline-flex">
            <ModelMetricItem
              icon={BadgeDollarSignIcon}
              tooltip={priceTooltip(model.price)}
              value={priceSummary(model.price)}
            />
          </span>
        </div>
      )}
      {hasModalities && (
        <div className="flex select-none flex-wrap items-center gap-1.5 border-border/60 border-t pt-2.5">
          <div className="flex flex-wrap items-center gap-1">
            <ModalityGroup
              label="Input"
              names={inputMods}
            />
            {inputMods.length > 0 && outputMods.length > 0 && (
              <HugeiconsIcon
                className="size-3.5 shrink-0 text-muted-foreground/50"
                icon={ArrowRight01Icon}
              />
            )}
            <ModalityGroup
              label="Output"
              names={outputMods}
            />
          </div>
        </div>
      )}
    </div>
  );
}
