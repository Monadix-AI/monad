'use client';

import type { ModelInfo, ProviderView } from '@monad/protocol';

import {
  cn,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '@monad/ui';
import {
  ArrowRight,
  AudioWaveform,
  Check,
  ChevronsUpDown,
  Database,
  FileText,
  ImageIcon,
  Search,
  Type,
  Video
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useProviderMeta } from '@/lib/ProviderMeta';
import { ModelPriceTag } from './shared';

function ModelOptionContent({ model }: { model: ModelInfo }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5 py-0.5">
      <span className="truncate font-medium text-xs">{model.label ?? model.id}</span>
      {model.label && <span className="truncate font-mono text-[10px] text-muted-foreground">{model.id}</span>}
      {model.price && <ModelPriceTag price={model.price} />}
    </span>
  );
}

function modelMatchesQuery(model: ModelInfo, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return model.id.toLowerCase().includes(q) || (model.label?.toLowerCase().includes(q) ?? false);
}

export function splitModelSpec(value: string): { modelId: string; providerId: string } | null {
  const i = value.indexOf(':');
  if (i <= 0) return null;
  return { providerId: value.slice(0, i), modelId: value.slice(i + 1) };
}

export const ROLE_NONE = '__none__';

function ModelPopover({
  disabled,
  emptyLabel,
  modelFilter,
  models: allModels,
  noneLabel,
  onSelect,
  providerId,
  selectedModelId,
  triggerLabel
}: {
  disabled?: boolean;
  emptyLabel?: string;
  modelFilter?: (model: ModelInfo) => boolean;
  models: ModelInfo[];
  noneLabel?: string;
  onSelect: (value: string) => void;
  providerId: string;
  selectedModelId: string;
  triggerLabel?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // A model with no modality data passes every role filter — we can't prove it ineligible, so
  // let the user decide (matches ProviderModelSelect's providerModels rule).
  const eligibleModels = modelFilter ? allModels.filter((m) => !m.modalities || modelFilter(m)) : allModels;
  const filteredModels = eligibleModels.filter((m) => modelMatchesQuery(m, query));
  const selectedModel = allModels.find((m) => m.id === selectedModelId);

  const listModels =
    !query.trim() && selectedModel && !filteredModels.some((m) => m.id === selectedModel.id)
      ? [selectedModel, ...filteredModels]
      : filteredModels;

  const hasNone = !!noneLabel;
  const totalCount = listModels.length + (hasNone ? 1 : 0);

  useEffect(() => {
    if (!open) return;
    setHighlighted(0);
    setQuery('');
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      listRef.current?.querySelector('[data-selected]')?.scrollIntoView({ block: 'nearest' });
    });
  }, [open]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlighted((h) => Math.min(h + 1, totalCount - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (hasNone && highlighted === 0) {
        onSelect(ROLE_NONE);
        setOpen(false);
      } else {
        const item = listModels[highlighted - (hasNone ? 1 : 0)];
        if (item) {
          onSelect(`${providerId}:${item.id}`);
          setOpen(false);
        }
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <Popover
      onOpenChange={setOpen}
      open={open}
    >
      <PopoverTrigger asChild>
        {triggerLabel ? (
          <button
            className={cn(
              'flex h-7 items-center rounded-(--radius-sm) border border-input bg-transparent px-2 text-muted-foreground text-xs outline-none transition-colors',
              'hover:bg-accent hover:text-accent-foreground',
              'disabled:cursor-not-allowed disabled:opacity-50',
              'data-[state=open]:bg-accent data-[state=open]:text-accent-foreground'
            )}
            disabled={disabled}
            type="button"
          >
            {triggerLabel}
          </button>
        ) : (
          <button
            className={cn(
              'flex h-8 w-full items-center justify-between gap-1.5 rounded-(--radius-sm) border border-input bg-transparent px-2.5 py-1 text-sm leading-control outline-none transition-[background-color,border-color,box-shadow,color] duration-150',
              'focus-visible:border-ring focus-visible:bg-card focus-visible:ring-[3px] focus-visible:ring-ring/30',
              'disabled:cursor-not-allowed disabled:opacity-50',
              'data-[state=open]:border-ring data-[state=open]:bg-card data-[state=open]:ring-[3px] data-[state=open]:ring-ring/30'
            )}
            disabled={disabled}
            type="button"
          >
            <span className="min-w-0 flex-1 truncate text-left">
              {selectedModel ? (
                <span className="truncate font-medium text-sm">{selectedModel.label ?? selectedModel.id}</span>
              ) : (
                <span className="text-muted-foreground">{noneLabel ?? t('web.model.filterPlaceholder')}</span>
              )}
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-max min-w-[max(var(--radix-popover-trigger-width),14rem)] max-w-[360px] p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
        sideOffset={4}
      >
        <div className="border-b p-1.5">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              className="flex h-8 w-full rounded-(--radius-sm) bg-transparent pr-2 pl-7 text-xs outline-none placeholder:text-muted-foreground"
              onChange={(e) => {
                setQuery(e.target.value);
                setHighlighted(0);
              }}
              onKeyDown={handleKeyDown}
              placeholder={t('web.model.filterPlaceholder')}
              ref={inputRef}
              value={query}
            />
          </div>
        </div>
        <div
          className="max-h-64 overflow-y-auto p-1"
          ref={listRef}
        >
          {hasNone && (
            <button
              className={cn(
                'flex w-full items-center rounded px-2 py-1.5 text-muted-foreground text-xs transition-colors hover:bg-accent hover:text-accent-foreground',
                highlighted === 0 && 'bg-accent text-accent-foreground'
              )}
              onClick={() => {
                onSelect(ROLE_NONE);
                setOpen(false);
              }}
              onMouseEnter={() => setHighlighted(0)}
              type="button"
            >
              {noneLabel}
            </button>
          )}
          {listModels.map((model, i) => {
            const idx = i + (hasNone ? 1 : 0);
            const isSelected = model.id === selectedModelId;
            return (
              <button
                className={cn(
                  'flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground',
                  idx === highlighted && 'bg-accent text-accent-foreground'
                )}
                data-selected={isSelected || undefined}
                key={model.id}
                onClick={() => {
                  onSelect(`${providerId}:${model.id}`);
                  setOpen(false);
                }}
                onMouseEnter={() => setHighlighted(idx)}
                type="button"
              >
                <ModelOptionContent model={model} />
                {isSelected && <Check className="ml-auto size-3 shrink-0 text-primary" />}
              </button>
            );
          })}
          {listModels.length === 0 && !hasNone && (
            <p className="px-2 py-1.5 text-muted-foreground text-xs">{emptyLabel ?? 'No models'}</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

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
  const providerId = draftProviderId;
  const providerModels = (providerId ? (modelsByProvider[providerId] ?? []) : []).filter(
    modelFilter ? (m) => !m.modalities || modelFilter(m) : () => true
  );
  const hasList = providerModels.length > 0;
  const selectedModelId = parsed?.modelId ?? '';

  // Local draft — not committed until Enter. Clears naturally when the popover closes
  // (ProviderModelSelect unmounts), so the next open starts fresh from selectedModelId.
  const [inputDraft, setInputDraft] = useState(selectedModelId);

  useEffect(() => {
    if (parsed?.providerId) setDraftProviderId(parsed.providerId);
  }, [parsed?.providerId]);

  // Keep draft in sync when parent commits a value (e.g. list picker selection).
  useEffect(() => {
    setInputDraft(selectedModelId);
  }, [selectedModelId]);

  const handleProviderChange = (nextProviderId: string) => {
    setDraftProviderId(nextProviderId);
  };

  const commitDraft = () => {
    const trimmed = inputDraft.trim();
    if (!trimmed) {
      if (noneLabel) (onSelect ?? onValueChange)(ROLE_NONE);
      return;
    }
    (onSelect ?? onValueChange)(`${providerId}:${trimmed}`);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-1.5">
        <Select
          disabled={providers.length === 0}
          onValueChange={handleProviderChange}
          value={providerId}
        >
          <SelectTrigger className="w-[7rem] shrink-0">
            <SelectValue placeholder="Provider" />
          </SelectTrigger>
          <SelectContent>
            {providers.map((provider) => {
              const meta = metaFor(provider.type);
              const ProvLogo = meta.logo;
              return (
                <SelectItem
                  key={provider.id}
                  value={provider.id}
                >
                  <span className="flex items-center gap-1.5">
                    <ProvLogo className={cn('size-3.5 shrink-0', meta.color)} />
                    {provider.label}
                  </span>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>

        <div className="relative min-w-0 flex-1">
          <input
            className={cn(
              'flex h-8 w-full rounded-(--radius-sm) border border-input bg-transparent px-2.5 text-xs outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground',
              'focus:border-ring focus:ring-[3px] focus:ring-ring/30',
              hasList && 'pr-16'
            )}
            onChange={(e) => setInputDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitDraft();
            }}
            placeholder="model-id"
            value={inputDraft}
          />
          {hasList && (
            <div className="absolute inset-y-0 right-0 flex items-center pr-1">
              <ModelPopover
                disabled={!providerId}
                emptyLabel={emptyLabel}
                key={providerId}
                modelFilter={modelFilter}
                models={providerModels}
                noneLabel={noneLabel}
                onSelect={(spec) => (onSelect ?? onValueChange)(spec)}
                providerId={providerId}
                selectedModelId={selectedModelId}
                triggerLabel="Select"
              />
            </div>
          )}
        </div>
      </div>

      {noneLabel && (
        <div className="flex justify-end">
          <button
            className="text-muted-foreground text-xs transition-colors hover:text-foreground"
            onClick={() => (onSelect ?? onValueChange)(ROLE_NONE)}
            type="button"
          >
            {noneLabel}
          </button>
        </div>
      )}
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
    <Tooltip>
      <TooltipTrigger asChild>
        <div className={cn('flex size-7 items-center justify-center rounded-lg', meta.bg)}>
          <Icon className={cn('size-3.5', meta.fg)} />
        </div>
      </TooltipTrigger>
      <TooltipContent>{meta.label}</TooltipContent>
    </Tooltip>
  );
}

export function ModelHoverCardBody({ model }: { model: ModelInfo | undefined }) {
  if (!model) return <p className="text-muted-foreground text-xs">Model details not loaded</p>;
  const inputMods = model.modalities?.input ?? [];
  const outputMods =
    model.modalities?.output ?? (model.modalities?.kind ? (KIND_OUTPUT[model.modalities.kind] ?? []) : []);
  const hasModalities = inputMods.length > 0 || outputMods.length > 0;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        {model.label && model.label !== model.id && <p className="font-medium text-sm">{model.label}</p>}
        <p className="break-all font-mono text-muted-foreground text-xs">{model.id}</p>
      </div>
      {model.price && (
        <ModelPriceTag
          className="flex-wrap"
          price={model.price}
        />
      )}
      {hasModalities && (
        <div className="flex flex-col gap-1.5">
          <p className="font-medium text-[10px] text-muted-foreground uppercase tracking-wide">Modalities</p>
          <div className="flex flex-wrap items-center gap-1">
            {inputMods.map((cap) => (
              <ModalityBadge
                key={`in-${cap}`}
                name={cap}
              />
            ))}
            {inputMods.length > 0 && outputMods.length > 0 && (
              <ArrowRight className="size-3.5 shrink-0 text-muted-foreground/50" />
            )}
            {outputMods.map((cap) => (
              <ModalityBadge
                key={`out-${cap}`}
                name={cap}
              />
            ))}
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
  onValueChange,
  providers,
  value
}: {
  children: React.ReactNode;
  modelFilter?: (model: ModelInfo) => boolean;
  modelsByProvider: Record<string, ModelInfo[]>;
  noneLabel?: string;
  onValueChange: (value: string) => void;
  providers: ProviderView[];
  value: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      onOpenChange={setOpen}
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
            setOpen(false);
          }}
          onValueChange={onValueChange}
          providers={providers}
          value={value}
        />
      </PopoverContent>
    </Popover>
  );
}
