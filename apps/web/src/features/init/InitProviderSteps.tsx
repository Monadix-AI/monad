'use client';

import type { useT } from '#/components/I18nProvider';
import type { DraftProvider, InitProviderMeta } from './InitWizardTypes';

import { Cancel01Icon, LockIcon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button, cn } from '@monad/ui';

type TFunction = ReturnType<typeof useT>;

export function InitProviderListStep({
  goAddKeyToProvider,
  goPickType,
  goToModelStep,
  onSkip,
  onBack,
  providers,
  removeKey,
  saveError,
  metaFor,
  t
}: {
  goAddKeyToProvider: (provider: DraftProvider) => void;
  goPickType: () => void;
  goToModelStep: () => void;
  onSkip: () => void;
  onBack: () => void;
  providers: DraftProvider[];
  removeKey: (providerId: string, keyId: string) => void;
  saveError: string;
  metaFor: (type: string) => InitProviderMeta;
  t: TFunction;
}) {
  return (
    <div className="flex flex-col gap-4">
      {providers.length === 0 ? (
        <div className="panel-subtle border-dashed py-8 text-center">
          <p className="text-muted-foreground text-sm">{t('web.init.noProviders')}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {providers.map((provider) => (
            <ProviderCard
              goAddKeyToProvider={goAddKeyToProvider}
              key={provider.id}
              meta={metaFor(provider.type)}
              provider={provider}
              removeKey={removeKey}
              t={t}
            />
          ))}
        </div>
      )}

      <button
        className="panel-subtle flex w-full items-center justify-center gap-1.5 border-dashed py-2.5 text-muted-foreground text-sm transition-colors hover:border-foreground/30 hover:text-foreground"
        onClick={goPickType}
        type="button"
      >
        <HugeiconsIcon
          className="h-4 w-4"
          icon={PlusSignIcon}
        />
        {t('web.init.addProvider')}
      </button>

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
        <div className="flex items-center gap-2">
          <Button
            onClick={onSkip}
            size="sm"
            variant="ghost"
          >
            {t('web.init.skipForNow')}
          </Button>
          <Button
            disabled={providers.length === 0}
            onClick={goToModelStep}
            size="sm"
          >
            {t('web.init.continueArrow')}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ProviderCard({
  goAddKeyToProvider,
  meta,
  provider,
  removeKey,
  t
}: {
  goAddKeyToProvider: (provider: DraftProvider) => void;
  meta: InitProviderMeta;
  provider: DraftProvider;
  removeKey: (providerId: string, keyId: string) => void;
  t: TFunction;
}) {
  const Logo = meta.logo;

  return (
    <div className="panel-subtle px-4 py-3">
      <div className="mb-2 flex items-center gap-2">
        {Logo && <Logo className={cn('h-4 w-4 shrink-0', meta.color)} />}
        <span className="font-medium text-sm">{meta.label ?? provider.type}</span>
        {provider.baseUrl && (
          <span className="truncate font-mono text-muted-foreground text-xs">{provider.baseUrl}</span>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        {provider.keys.map((key) => (
          <div
            className="flex items-center justify-between gap-2"
            key={key.id}
          >
            <span className="font-mono text-muted-foreground text-xs">
              {'••••••••'}
              {key.saved ? '····' : key.accessToken.slice(-4)}
            </span>
            {key.saved ? (
              <HugeiconsIcon
                aria-label={t('web.init.savedKey')}
                className="h-3 w-3 text-muted-foreground/40"
                icon={LockIcon}
              />
            ) : (
              <button
                aria-label={t('web.init.removeKey')}
                className="text-muted-foreground/50 transition-colors hover:text-destructive"
                onClick={() => removeKey(provider.id, key.id)}
                type="button"
              >
                <HugeiconsIcon
                  className="h-3.5 w-3.5"
                  icon={Cancel01Icon}
                />
              </button>
            )}
          </div>
        ))}
        <button
          className="flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
          onClick={() => goAddKeyToProvider(provider)}
          type="button"
        >
          <HugeiconsIcon
            className="h-3 w-3"
            icon={PlusSignIcon}
          />
          {t('web.init.addKey')}
        </button>
      </div>
    </div>
  );
}

export function InitProviderTypePickerStep({
  onBack,
  pickProviderType,
  providerTypes,
  metaFor,
  t
}: {
  onBack: () => void;
  pickProviderType: (type: string) => void;
  providerTypes: string[];
  metaFor: (type: string) => InitProviderMeta;
  t: TFunction;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid max-h-88 grid-cols-[repeat(auto-fill,minmax(6.75rem,1fr))] gap-2 overflow-y-auto pr-1">
        {providerTypes.map((type) => {
          const meta = metaFor(type);
          const Logo = meta.logo;
          return (
            <button
              className={cn(
                'group flex min-h-20 flex-col items-center justify-center gap-2 rounded-md border border-border/70 bg-card/40 p-2.5 text-center',
                'transition-[background-color,border-color,color] duration-150 ease-out',
                'hover:border-foreground/30 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
              )}
              key={type}
              onClick={() => pickProviderType(type)}
              type="button"
            >
              {Logo && (
                <Logo className={cn('size-5 transition-colors duration-150', meta.color || 'text-foreground')} />
              )}
              <span className="line-clamp-2 text-[11px] text-muted-foreground leading-tight transition-colors group-hover:text-foreground">
                {meta.label}
              </span>
            </button>
          );
        })}
      </div>
      <button
        className="text-muted-foreground text-xs hover:text-foreground"
        onClick={onBack}
        type="button"
      >
        {t('web.init.back')}
      </button>
    </div>
  );
}
