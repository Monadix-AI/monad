'use client';

import { configureBuiltinNativeCliObservationAdapters } from '@monad/atoms/native-cli-observation-setup';

import { I18nProvider } from '@/components/I18nProvider';
import { ToastProvider } from '@/components/ToastProvider';
import { MonadStoreProvider } from '@/lib/monad-runtime-provider';

// Composition root: the web loads the experience UI but not the atoms barrel, so wire the native-CLI
// observation parsers here. Without it the client renders structured provider output as raw JSON. The
// experience layer itself never imports an agent adapter — this app is where the two layers meet.
configureBuiltinNativeCliObservationAdapters();

export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <MonadStoreProvider>
      <I18nProvider>
        <ToastProvider>{children}</ToastProvider>
      </I18nProvider>
    </MonadStoreProvider>
  );
}
