import type { ReactNode } from 'react';
import type { useT } from '#/components/I18nProvider';

import { CheckIcon, SparklesIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button, cn } from '@monad/ui';

import { InitBackground } from './InitBackground';
import { InitLogoCanvas } from './InitLogoCanvas';

type TFunction = ReturnType<typeof useT>;

export function InitRestartingView({ t }: { t: TFunction }) {
  return (
    <>
      <InitBackground />
      <div className="flex h-screen items-center justify-center p-4">
        <div className="app-frame flex animate-init-rise flex-col items-center gap-4 px-8 py-7">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-current border-t-transparent opacity-50" />
          <p className="text-muted-foreground text-sm">{t('web.init.restarting')}</p>
        </div>
      </div>
    </>
  );
}

export function InitDoneView({ t }: { t: TFunction }) {
  return (
    <>
      <InitBackground />
      <div className="flex h-screen items-center justify-center p-4">
        <div className="app-frame flex w-full max-w-md animate-init-rise flex-col items-center gap-5 px-8 py-12 text-center">
          <div className="relative flex h-16 w-16 items-center justify-center">
            <span className="absolute inset-0 animate-init-ring rounded-full bg-success/40" />
            <span className="absolute inset-0 animate-init-ring rounded-full bg-success/30 [animation-delay:0.3s]" />
            <span className="flex h-16 w-16 animate-init-pop items-center justify-center rounded-full bg-success text-primary-foreground shadow-lg">
              <HugeiconsIcon
                className="h-8 w-8"
                icon={CheckIcon}
              />
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <h1 className="poster-heading text-3xl text-foreground">{t('web.init.doneTitle')}</h1>
            <p className="text-muted-foreground text-sm">{t('web.init.doneDesc')}</p>
          </div>
          <Button
            className="transition-transform hover:-translate-y-0.5 active:translate-y-0"
            onClick={() => window.location.assign('/')}
          >
            <span className="flex items-center gap-1.5">
              <HugeiconsIcon
                className="h-4 w-4"
                icon={SparklesIcon}
              />
              {t('web.init.enter')}
            </span>
          </Button>
        </div>
      </div>
    </>
  );
}

export function InitWizardHeader({
  description,
  stepIndex,
  title,
  t
}: {
  description: string;
  stepIndex: number;
  title: string;
  t: TFunction;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2.5">
        <div className="flex items-center gap-1.5">
          {[0, 1, 2, 3].map((i) => {
            const isActive = i === stepIndex;
            const isDone = i < stepIndex;
            return (
              <span
                className={cn(
                  'h-1.5 rounded-full transition-all duration-500 ease-out',
                  isActive
                    ? 'w-6 animate-init-pulse bg-foreground'
                    : isDone
                      ? 'w-4 bg-foreground/70'
                      : 'w-4 bg-muted-foreground/25'
                )}
                key={i}
              />
            );
          })}
        </div>
        <span className="flex items-center gap-1 text-muted-foreground text-xs">
          <HugeiconsIcon
            className="h-3 w-3 text-foreground/40"
            icon={SparklesIcon}
          />
          {t('web.init.step', { n: stepIndex + 1 })}
        </span>
      </div>
      <h1 className="poster-heading text-[2rem] text-foreground">{title}</h1>
      <p className="text-muted-foreground text-sm">{description}</p>
    </div>
  );
}

export function InitWizardFrame({ children }: { children: ReactNode }) {
  return (
    <>
      <InitBackground />
      <div className="flex min-h-screen items-center justify-center px-4 py-6 lg:px-8">
        <div className="grid min-h-[calc(100vh-3rem)] w-full max-w-6xl grid-cols-1 items-center gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(420px,520px)]">
          <div className="flex min-h-76 items-center justify-center lg:min-h-[560px]">
            <InitLogoCanvas />
          </div>
          <div className="app-frame flex w-full animate-init-rise flex-col gap-4 p-6 sm:p-7">{children}</div>
        </div>
      </div>
    </>
  );
}
