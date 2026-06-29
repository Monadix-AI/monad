'use client';

import type { ModelInfo, ProviderView } from '@monad/protocol';

import { ModelProviderType } from '@monad/protocol';
import { cn, Tooltip, TooltipContent, TooltipTrigger } from '@monad/ui';
import {
  ArrowLeft,
  ArrowRight,
  AudioWaveform,
  BookOpenText,
  Check,
  Database,
  Download,
  ExternalLink,
  FileText,
  ImageIcon,
  Type,
  Upload,
  Video
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useProviderMeta } from '@/lib/ProviderMeta';
import { ModelPriceTag } from './shared';

export interface HighlightPart {
  match: boolean;
  text: string;
}

function queryTerms(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/\s+/)
        .map((term) => term.trim())
        .filter(Boolean)
    )
  );
}

export function renderHighlightedModelText(text: string, query: string): HighlightPart[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [{ text, match: false }];

  const lower = text.toLowerCase();
  const ranges: Array<{ end: number; start: number }> = [];
  for (const term of terms) {
    let start = lower.indexOf(term);
    while (start >= 0) {
      ranges.push({ start, end: start + term.length });
      start = lower.indexOf(term, start + term.length);
    }
  }
  if (ranges.length === 0) return [{ text, match: false }];

  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: typeof ranges = [];
  for (const range of ranges) {
    const prev = merged.at(-1);
    if (prev && range.start <= prev.end) {
      prev.end = Math.max(prev.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  const parts: HighlightPart[] = [];
  let cursor = 0;
  for (const range of merged) {
    if (range.start > cursor) parts.push({ text: text.slice(cursor, range.start), match: false });
    parts.push({ text: text.slice(range.start, range.end), match: true });
    cursor = range.end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false });
  return parts;
}

function HighlightedModelText({ className, query, text }: { className?: string; query: string; text: string }) {
  let offset = 0;
  return (
    <span className={cn('block min-w-0', className)}>
      {renderHighlightedModelText(text, query).map((part) => {
        const key = `${part.match ? 'match' : 'text'}-${offset}-${part.text}`;
        offset += part.text.length;
        return part.match ? (
          <mark
            className="rounded bg-primary/15 px-0.5 text-primary"
            key={key}
          >
            {part.text}
          </mark>
        ) : (
          <span key={key}>{part.text}</span>
        );
      })}
    </span>
  );
}

function formatContextLimit(limit: number): string {
  return `${Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(limit)}`;
}

function formatPriceValue(value: number | undefined): string {
  if (value === undefined) return 'N/A';
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 4 })}`;
}

function formatOptionalPriceValue(value: number | undefined): string | undefined {
  return value === undefined ? undefined : formatPriceValue(value);
}

function formatCachePriceValue(cacheRead: number | undefined, cacheWrite: number | undefined): string {
  const values = [formatOptionalPriceValue(cacheRead), formatOptionalPriceValue(cacheWrite)].filter(
    (value): value is string => value !== undefined
  );
  return values.length > 0 ? values.join('/') : 'N/A';
}

function cachePriceTooltip(cacheRead: number | undefined, cacheWrite: number | undefined): React.ReactNode | undefined {
  if (cacheRead === undefined && cacheWrite === undefined) return undefined;
  return (
    <span className="flex flex-col gap-1">
      {cacheRead !== undefined && <span>Cache read {formatPriceValue(cacheRead)} /1M</span>}
      {cacheWrite !== undefined && <span>Cache write {formatPriceValue(cacheWrite)} /1M</span>}
    </span>
  );
}

function ContextLimitTag({
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
      <BookOpenText className="size-3 text-muted-foreground/70" />
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

function ModelMetricItem({
  icon: Icon,
  tooltip,
  value
}: {
  icon: React.ComponentType<{ className?: string }>;
  tooltip?: React.ReactNode;
  value: string;
}) {
  const content = (
    <span className="inline-flex min-w-0 flex-col items-start gap-1 text-muted-foreground tabular-nums">
      <Icon className="size-3 text-muted-foreground/70" />
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

function ModelOptionContent({ model, query }: { model: ModelInfo; query: string }) {
  const label = model.label ?? model.id;
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-1 py-0.5">
      <span className="min-w-0">
        <HighlightedModelText
          className="truncate font-medium text-xs"
          query={query}
          text={label}
        />
      </span>
      {model.label && (
        <span className="min-w-0">
          <HighlightedModelText
            className="truncate font-mono text-[10px] text-muted-foreground"
            query={query}
            text={model.id}
          />
        </span>
      )}
      {(model.price || model.contextLimit) && (
        <span className="flex select-none flex-wrap items-center gap-x-2 gap-y-1 text-[10px] [&>*]:inline-flex [&>*]:h-4 [&>*]:items-center">
          {model.contextLimit && (
            <span>
              <ContextLimitTag limit={model.contextLimit} />
            </span>
          )}
          {model.price && (
            <ModelPriceTag
              flat
              price={model.price}
              tooltip={false}
            />
          )}
        </span>
      )}
    </span>
  );
}

export function modelMatchesQuery(model: Pick<ModelInfo, 'id' | 'label'>, query: string): boolean {
  const terms = queryTerms(query);
  if (terms.length === 0) return true;
  const haystack = `${model.label ?? ''} ${model.id}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

const GATEWAY_PROVIDER_TYPES = new Set<string>([
  ModelProviderType.CloudflareGateway,
  ModelProviderType.OpenRouter,
  ModelProviderType.VercelGateway
]);

function modelReleaseTime(model: ModelInfo): number {
  if (!model.releaseDate) return 0;
  const time = Date.parse(model.releaseDate);
  return Number.isFinite(time) ? time : 0;
}

function modelBrandKey(model: ModelInfo): string {
  return model.id.includes('/') ? model.id.split('/')[0]?.toLowerCase() || '' : '';
}

function modelNameKey(model: ModelInfo): string {
  return (model.label ?? model.id).toLowerCase();
}

export function sortModelsForProvider(models: ModelInfo[], providerType: string | undefined): ModelInfo[] {
  const shouldGroupByBrand = providerType ? GATEWAY_PROVIDER_TYPES.has(providerType) : false;
  return [...models].sort((a, b) => {
    if (shouldGroupByBrand) {
      const brand = modelBrandKey(a).localeCompare(modelBrandKey(b));
      if (brand !== 0) return brand;
    }
    const release = modelReleaseTime(b) - modelReleaseTime(a);
    if (release !== 0) return release;
    return modelNameKey(a).localeCompare(modelNameKey(b));
  });
}

export function filterModelsForPicker<T extends Pick<ModelInfo, 'id' | 'label'>>(models: T[], query: string): T[] {
  return query.trim() ? models.filter((model) => modelMatchesQuery(model, query)) : models;
}

export function splitModelSpec(value: string): { modelId: string; providerId: string } | null {
  const i = value.indexOf(':');
  if (i <= 0) return null;
  return { providerId: value.slice(0, i), modelId: value.slice(i + 1) };
}

export const ROLE_NONE = '__none__';

function ProviderModelSelect({
  emptyLabel,
  modelFilter,
  modelsByProvider,
  noneLabel,
  onValueChange,
  onSelect,
  providers,
  value
}: {
  emptyLabel?: string;
  modelFilter?: (model: ModelInfo) => boolean;
  modelsByProvider: Record<string, ModelInfo[]>;
  noneLabel?: string;
  onValueChange: (value: string) => void;
  onSelect?: (value: string) => void;
  providers: ProviderView[];
  value: string;
}) {
  const { metaFor } = useProviderMeta();
  const isNoneValue = value === ROLE_NONE || !value;
  const parsed = isNoneValue ? null : splitModelSpec(value);
  const firstProviderId = providers[0]?.id ?? '';
  const [draftProviderId, setDraftProviderId] = useState(parsed?.providerId ?? firstProviderId);
  const [view, setView] = useState<'provider' | 'model'>(parsed?.providerId ? 'model' : 'provider');
  const providerId = draftProviderId;
  const activeProvider = providers.find((provider) => provider.id === providerId);
  const providerModels = useMemo(() => {
    const filtered = (providerId ? (modelsByProvider[providerId] ?? []) : []).filter(
      modelFilter ? (m) => !m.modalities || modelFilter(m) : () => true
    );
    return sortModelsForProvider(filtered, activeProvider?.type);
  }, [activeProvider?.type, modelFilter, modelsByProvider, providerId]);
  const hasList = providerModels.length > 0;
  const selectedModelId = parsed?.modelId ?? '';
  const modelButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  // Local draft — not committed until Enter. Clears naturally when the popover closes
  // (ProviderModelSelect unmounts), so the next open starts fresh from selectedModelId.
  const [inputDraft, setInputDraft] = useState(selectedModelId);
  const hasSearchQuery = inputDraft.trim().length > 0;

  useEffect(() => {
    if (parsed?.providerId) {
      setDraftProviderId(parsed.providerId);
      setView('model');
    }
  }, [parsed?.providerId]);

  // Keep draft in sync when parent commits a value (e.g. list picker selection).
  useEffect(() => {
    setInputDraft(selectedModelId);
  }, [selectedModelId]);

  useEffect(() => {
    if (!hasSearchQuery) return;
    const firstMatch = providerModels.find((model) => modelMatchesQuery(model, inputDraft));
    if (!firstMatch) return;
    modelButtonRefs.current[firstMatch.id]?.scrollIntoView({ block: 'nearest' });
  }, [hasSearchQuery, inputDraft, providerModels]);

  const selectProvider = (nextProviderId: string) => {
    setDraftProviderId(nextProviderId);
    setInputDraft('');
    setView('model');
  };

  const commitDraft = () => {
    const trimmed = inputDraft.trim();
    if (!trimmed) {
      if (noneLabel) (onSelect ?? onValueChange)(ROLE_NONE);
      return;
    }
    (onSelect ?? onValueChange)(`${providerId}:${trimmed}`);
  };

  const shownModels = filterModelsForPicker(providerModels, inputDraft);

  if (view === 'provider') {
    return (
      <div className="flex flex-col gap-1.5">
        <div className="px-1 pb-1 font-medium text-muted-foreground text-xs">Provider</div>
        <div className="max-h-72 overflow-y-auto">
          {providers.length === 0 ? (
            <p className="px-2 py-1.5 text-muted-foreground text-xs">No providers</p>
          ) : (
            providers.map((provider) => {
              const meta = metaFor(provider.type);
              const ProvLogo = meta.logo;
              return (
                <button
                  className={cn(
                    'flex h-9 w-full items-center gap-2 rounded-(--radius-sm) px-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground',
                    provider.id === providerId && 'bg-accent/60 text-accent-foreground'
                  )}
                  key={provider.id}
                  onClick={() => selectProvider(provider.id)}
                  type="button"
                >
                  <ProvLogo className={cn('size-3.5 shrink-0', meta.color)} />
                  <span className="min-w-0 flex-1 truncate">{provider.label}</span>
                  <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
                </button>
              );
            })
          )}
        </div>

        {noneLabel && (
          <button
            className="mt-1 rounded-(--radius-sm) px-2 py-1.5 text-left text-muted-foreground text-xs transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => (onSelect ?? onValueChange)(ROLE_NONE)}
            type="button"
          >
            {noneLabel}
          </button>
        )}
      </div>
    );
  }

  const activeMeta = metaFor(activeProvider?.type ?? '');
  const ActiveLogo = activeMeta.logo;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 border-border/50 border-b px-1 pb-2">
        <button
          aria-label="Back to providers"
          className="flex size-7 shrink-0 items-center justify-center rounded-(--radius-sm) text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={() => setView('provider')}
          type="button"
        >
          <ArrowLeft className="size-3.5" />
        </button>
        <ActiveLogo className={cn('size-3.5 shrink-0', activeMeta.color)} />
        <span className="min-w-0 flex-1 truncate font-medium text-sm">{activeProvider?.label ?? providerId}</span>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="relative min-w-0">
          <input
            className={cn(
              'flex h-8 w-full rounded-(--radius-sm) border border-input bg-transparent px-2.5 text-xs outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground',
              'focus:border-ring focus:ring-[3px] focus:ring-ring/30'
            )}
            onChange={(e) => setInputDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitDraft();
            }}
            placeholder="model-id"
            value={inputDraft}
          />
        </div>

        {hasList ? (
          <div className="max-h-64 overflow-y-auto rounded-(--radius-sm) border border-border/60 p-1">
            {shownModels.map((model) => {
              const isSelected = model.id === selectedModelId;
              const isSearchMatch = hasSearchQuery && modelMatchesQuery(model, inputDraft);
              return (
                <button
                  className={cn(
                    'flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground',
                    isSearchMatch && 'bg-accent/60 text-accent-foreground'
                  )}
                  key={model.id}
                  onClick={() => (onSelect ?? onValueChange)(`${providerId}:${model.id}`)}
                  ref={(node) => {
                    modelButtonRefs.current[model.id] = node;
                  }}
                  type="button"
                >
                  <ModelOptionContent
                    model={model}
                    query={inputDraft}
                  />
                  {isSelected && <Check className="ml-auto size-3 shrink-0 text-primary" />}
                </button>
              );
            })}
            {shownModels.length === 0 && (
              <p className="px-2 py-1.5 text-muted-foreground text-xs">{emptyLabel ?? 'No models'}</p>
            )}
          </div>
        ) : (
          <p className="px-2 py-1.5 text-muted-foreground text-xs">{emptyLabel ?? 'No models'}</p>
        )}

        {noneLabel && (
          <button
            className="self-end text-muted-foreground text-xs transition-colors hover:text-foreground"
            onClick={() => (onSelect ?? onValueChange)(ROLE_NONE)}
            type="button"
          >
            {noneLabel}
          </button>
        )}
      </div>
    </div>
  );
}
const MODALITY_ICON: Record<
  string,
  { icon: React.ComponentType<{ className?: string }>; bg: string; fg: string; label: string }
> = {
  text: { icon: Type, bg: 'bg-cyan-500/20', fg: 'text-cyan-400', label: 'Text' },
  image: { icon: ImageIcon, bg: 'bg-green-500/20', fg: 'text-green-400', label: 'Image' },
  video: { icon: Video, bg: 'bg-amber-500/20', fg: 'text-amber-400', label: 'Video' },
  audio: { icon: AudioWaveform, bg: 'bg-purple-500/20', fg: 'text-purple-400', label: 'Audio' },
  pdf: { icon: FileText, bg: 'bg-blue-500/20', fg: 'text-blue-400', label: 'PDF' },
  file: { icon: FileText, bg: 'bg-blue-500/20', fg: 'text-blue-400', label: 'File' },
  embedding: { icon: Database, bg: 'bg-muted', fg: 'text-muted-foreground', label: 'Embedding' }
};
const MODALITY_FALLBACK = (name: string) => ({
  icon: FileText as React.ComponentType<{ className?: string }>,
  bg: 'bg-muted',
  fg: 'text-muted-foreground',
  label: name.charAt(0).toUpperCase() + name.slice(1)
});

const KIND_OUTPUT: Record<string, string[]> = {
  chat: ['text'],
  image: ['image'],
  video: ['video'],
  speech: ['audio'],
  embedding: ['embedding']
};

function ModalityBadge({ name }: { name: string }) {
  const meta = MODALITY_ICON[name] ?? MODALITY_FALLBACK(name);
  const Icon = meta.icon;
  return (
    <div className={cn('flex size-6 items-center justify-center rounded-(--radius-sm)', meta.bg)}>
      <Icon className={cn('size-3.5', meta.fg)} />
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
  if (!model) return <p className="text-muted-foreground text-xs">Model details not loaded</p>;
  const label = model.label && model.label !== model.id ? model.label : undefined;
  const inputMods = model.modalities?.input ?? [];
  const outputMods =
    model.modalities?.output ?? (model.modalities?.kind ? (KIND_OUTPUT[model.modalities.kind] ?? []) : []);
  const hasModalities = inputMods.length > 0 || outputMods.length > 0;
  const detailLink = model.modelsDevUrl ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          aria-label="See detail"
          className="inline-flex size-5 shrink-0 select-none items-center justify-center rounded-(--radius-sm) text-muted-foreground transition-colors hover:text-foreground"
          draggable={false}
          href={model.modelsDevUrl}
          onDragStart={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
          rel="noreferrer"
          target="_blank"
        >
          <ExternalLink className="size-3" />
        </a>
      </TooltipTrigger>
      <TooltipContent>See detail</TooltipContent>
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
      <div className="flex select-none flex-wrap items-stretch border-border/60 border-t py-2.5 text-[10px] [&>*+*]:border-border/80 [&>*+*]:border-l [&>*:first-child]:pl-0 [&>*]:px-2">
        <span className="inline-flex">
          <ModelMetricItem
            icon={BookOpenText}
            tooltip={
              model.contextLimit ? `Context window: ${model.contextLimit.toLocaleString('en-US')} tokens` : undefined
            }
            value={model.contextLimit ? formatContextLimit(model.contextLimit) : 'N/A'}
          />
        </span>
        <span className="inline-flex">
          <ModelMetricItem
            icon={Download}
            tooltip={model.price?.input !== undefined ? `Input ${formatPriceValue(model.price.input)} /1M` : undefined}
            value={formatPriceValue(model.price?.input)}
          />
        </span>
        <span className="inline-flex">
          <ModelMetricItem
            icon={Upload}
            tooltip={
              model.price?.output !== undefined ? `Output ${formatPriceValue(model.price.output)} /1M` : undefined
            }
            value={formatPriceValue(model.price?.output)}
          />
        </span>
        <span className="inline-flex">
          <ModelMetricItem
            icon={Database}
            tooltip={cachePriceTooltip(model.price?.cacheRead, model.price?.cacheWrite)}
            value={formatCachePriceValue(model.price?.cacheRead, model.price?.cacheWrite)}
          />
        </span>
      </div>
      {hasModalities && (
        <div className="flex select-none flex-wrap items-center gap-1.5 border-border/60 border-t pt-2.5">
          <div className="flex flex-wrap items-center gap-1">
            <ModalityGroup
              label="Input"
              names={inputMods}
            />
            {inputMods.length > 0 && outputMods.length > 0 && (
              <ArrowRight className="size-3.5 shrink-0 text-muted-foreground/50" />
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

export function ModelPickerPopover({
  children,
  modelFilter,
  modelsByProvider,
  noneLabel,
  onOpenChange,
  onValueChange,
  providers,
  value
}: {
  children: React.ReactNode;
  modelFilter?: (model: ModelInfo) => boolean;
  modelsByProvider: Record<string, ModelInfo[]>;
  noneLabel?: string;
  onOpenChange?: (open: boolean) => void;
  onValueChange: (value: string) => void;
  providers: ProviderView[];
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };
  return (
    <Popover
      onOpenChange={handleOpenChange}
      open={open}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[22rem] p-2"
        side="bottom"
      >
        <ProviderModelSelect
          modelFilter={modelFilter}
          modelsByProvider={modelsByProvider}
          noneLabel={noneLabel}
          onSelect={(v) => {
            onValueChange(v);
            handleOpenChange(false);
          }}
          onValueChange={onValueChange}
          providers={providers}
          value={value}
        />
      </PopoverContent>
    </Popover>
  );
}
