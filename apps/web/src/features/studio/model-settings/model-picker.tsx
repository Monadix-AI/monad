'use client';

import type { ModelInfo, ProviderView } from '@monad/protocol';

import { ArrowLeft01Icon, ArrowRight01Icon, CheckIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { ModelProviderType } from '@monad/protocol';
import { cn } from '@monad/ui';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { Popover, PopoverContent, PopoverTrigger } from '#/components/ui/popover';
import { useProviderMeta } from '#/lib/ProviderMeta';
import { ContextLimitTag, ModelOptionPriceTag } from './model-picker-metadata';

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
          {model.price && <ModelOptionPriceTag price={model.price} />}
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
  const t = useT();
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
  const inputRef = useRef<HTMLInputElement | null>(null);
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

  useEffect(() => {
    if (view !== 'model') return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [view]);

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
        <div className="px-1 pb-1 font-medium text-muted-foreground text-xs">{t('web.modelPicker.provider')}</div>
        <div className="max-h-72 overflow-y-auto">
          {providers.length === 0 ? (
            <p className="px-2 py-1.5 text-muted-foreground text-xs">{t('web.modelPicker.noProviders')}</p>
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
                  <HugeiconsIcon
                    className="size-3.5 shrink-0 text-muted-foreground"
                    icon={ArrowRight01Icon}
                  />
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
          aria-label={t('web.modelPicker.backProviders')}
          className="flex size-7 shrink-0 items-center justify-center rounded-(--radius-sm) text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={() => setView('provider')}
          type="button"
        >
          <HugeiconsIcon
            className="size-3.5"
            icon={ArrowLeft01Icon}
          />
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
            ref={inputRef}
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
                  {isSelected && (
                    <HugeiconsIcon
                      className="ml-auto size-3 shrink-0 text-primary"
                      icon={CheckIcon}
                    />
                  )}
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

export { ModelHoverCardBody, modelPickerPriceSummary } from './model-picker-metadata';
