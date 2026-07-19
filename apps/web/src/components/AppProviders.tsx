import { configureBuiltinMeshAgentObservationAdapters } from '@monad/atoms/mesh-agent-observation-setup';
import { TooltipProvider } from '@monad/ui';
import { lazy, type ReactNode, Suspense } from 'react';

import { I18nProvider } from '#/components/I18nProvider';
import { ToastProvider } from '#/components/ToastProvider';
import { HostInteractionDialog } from '#/features/interactions/HostInteractionDialog';
import { MonadStoreProvider } from '#/lib/monad-runtime-provider';
import '../styles/globals.css';
import '../features/workspace/workspace.css';

const DevToolsWidget =
  process.env.NODE_ENV === 'production'
    ? null
    : lazy(() => import('#/features/shell/DevToolsWidget').then((m) => ({ default: m.DevToolsWidget })));

configureBuiltinMeshAgentObservationAdapters();

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <MonadStoreProvider>
      <I18nProvider>
        <ToastProvider>
          <TooltipProvider delayDuration={200}>
            {children}
            <HostInteractionDialog />
            {DevToolsWidget ? (
              <Suspense fallback={null}>
                <DevToolsWidget />
              </Suspense>
            ) : null}
          </TooltipProvider>
        </ToastProvider>
      </I18nProvider>
    </MonadStoreProvider>
  );
}
