'use client';

import type { useT } from '#/components/I18nProvider';
import type { DraftProvider, InitProviderMeta } from './InitWizardTypes';

import { CheckIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button, cn, Input } from '@monad/ui';

type TFunction = ReturnType<typeof useT>;

export function InitModelStep({
  modelFilter,
  onBack,
  onSave,
  providers,
  saveError,
  saving,
  selectedModelId,
  selectedProviderId,
  setModelFilter,
  setSelectedModelId,
  setSelectedProviderId,
  metaFor,
  t
}: {
  modelFilter: string;
  onBack: () => void;
  onSave: () => void;
  providers: DraftProvider[];
  saveError: string;
  saving: boolean;
  selectedModelId: string;
  selectedProviderId: string;
  setModelFilter: (value: string) => void;
  setSelectedModelId: (value: string) => void;
  setSelectedProviderId: (value: string) => void;
  metaFor: (type: string) => InitProviderMeta;
  t: TFunction;
}) {
  const activeProvider = providers.find((provider) => provider.id === selectedProviderId) ?? providers[0];
  const activeProviderMeta = activeProvider ? metaFor(activeProvider.type) : null;
  const q = modelFilter.trim().toLowerCase();
  const providerModels = activeProvider?.models.map((model) => ({ provider: activeProvider, model })) ?? [];
  const filtered = providerModels.filter(
    ({ model }) => !q || (model.label ?? model.id).toLowerCase().includes(q) || model.id.toLowerCase().includes(q)
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(8rem,1fr))] gap-2">
        {providers.map((provider) => {
          const meta = metaFor(provider.type);
          const Logo = meta.logo;
          const selected = (selectedProviderId || providers[0]?.id) === provider.id;
          return (
            <button
              className={cn(
                'panel-subtle flex min-w-0 items-center gap-2 px-3 py-2 text-left transition-[background-color,border-color,color] duration-150',
                selected ? 'border-foreground/40 bg-accent text-foreground' : 'hover:bg-muted/50'
              )}
              key={provider.id}
              onClick={() => {
                setSelectedProviderId(provider.id);
                setSelectedModelId('');
                setModelFilter('');
              }}
              type="button"
            >
              {Logo && <Logo className={cn('size-4 shrink-0', meta.color)} />}
              <span className="min-w-0 flex-1 truncate text-sm">{meta.label ?? provider.type}</span>
              {provider.models.length > 0 ? (
                <span className="font-mono text-[10px] text-muted-foreground">{provider.models.length}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      <Input
        autoFocus
        onChange={(event) => {
          setModelFilter(event.target.value);
          setSelectedModelId('');
          setSelectedProviderId(activeProvider?.id ?? '');
        }}
        placeholder={
          providerModels.length > 0
            ? `${t('web.init.modelFilter')} ${activeProviderMeta?.label ?? ''}`.trim()
            : t('web.init.modelPlaceholder')
        }
        value={modelFilter}
      />
      {filtered.length > 0 && (
        <div className="flex max-h-60 flex-col gap-1 overflow-y-auto pr-1">
          {filtered.map(({ provider, model }) => {
            const meta = metaFor(provider.type);
            const Logo = meta.logo;
            const isSelected = selectedProviderId === provider.id && selectedModelId === model.id;
            return (
              <button
                className={cn(
                  'panel-subtle flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-all duration-200',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  isSelected
                    ? 'border-foreground/40 bg-accent font-medium shadow-sm'
                    : 'border-transparent hover:translate-x-0.5 hover:border-border hover:bg-muted/50'
                )}
                key={`${provider.id}:${model.id}`}
                onClick={() => {
                  setSelectedProviderId(provider.id);
                  setSelectedModelId(model.id);
                  setModelFilter(model.label ?? model.id);
                }}
                type="button"
              >
                {Logo && <Logo className={cn('h-3.5 w-3.5 shrink-0', meta.color)} />}
                <span className="truncate">{model.label ?? model.id}</span>
                {isSelected && (
                  <HugeiconsIcon
                    className="ml-auto h-3.5 w-3.5 shrink-0 animate-init-pop"
                    icon={CheckIcon}
                  />
                )}
              </button>
            );
          })}
        </div>
      )}

      {saveError && (
        <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-destructive text-xs">
          {saveError}
        </p>
      )}

      <div className="flex items-center justify-between">
        <button
          className="text-muted-foreground text-xs hover:text-foreground"
          onClick={onBack}
          type="button"
        >
          {t('web.init.back')}
        </button>
        <Button
          disabled={(!selectedModelId && !modelFilter.trim()) || saving}
          onClick={onSave}
          size="sm"
        >
          {saving ? (
            <span className="flex items-center gap-2">
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
              {t('web.init.saving')}
            </span>
          ) : (
            <span className="flex items-center gap-1.5">{t('web.init.next')}</span>
          )}
        </Button>
      </div>
    </div>
  );
}
