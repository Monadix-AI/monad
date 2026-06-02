'use client';

import { I18nProvider } from '@/components/I18nProvider';
import { ToastProvider } from '@/components/ToastProvider';
import { MonadStoreProvider } from '@/lib/monad-runtime-provider';

export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <MonadStoreProvider>
      <I18nProvider>
        <ToastProvider>{children}</ToastProvider>
      </I18nProvider>
    </MonadStoreProvider>
  );
}
