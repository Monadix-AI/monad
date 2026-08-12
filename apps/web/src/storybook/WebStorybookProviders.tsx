import type { ReactElement, ReactNode } from 'react';

import { TooltipProvider } from '@monad/ui';

import { I18nProvider } from '#/components/I18nProvider';
import { ToastProvider } from '#/components/ToastProvider';
import { MonadStoreProvider } from '#/lib/monad-runtime-provider';

function WebStorybookProviders({ children }: { children: ReactNode }) {
  return (
    <MonadStoreProvider>
      <I18nProvider>
        <ToastProvider>
          <TooltipProvider delayDuration={200}>
            <div className="min-h-screen bg-background font-ui text-foreground">{children}</div>
          </TooltipProvider>
        </ToastProvider>
      </I18nProvider>
    </MonadStoreProvider>
  );
}

export function withWebStorybookProviders(Story: () => ReactElement) {
  return (
    <WebStorybookProviders>
      <Story />
    </WebStorybookProviders>
  );
}
