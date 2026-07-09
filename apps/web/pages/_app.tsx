import type { AppProps } from 'next/app';

import { configureBuiltinExternalAgentObservationAdapters } from '@monad/atoms/external-agent-observation-setup';
import { TooltipProvider } from '@monad/ui';
import dynamic from 'next/dynamic';
import Head from 'next/head';

import { I18nProvider } from '#/components/I18nProvider';
import { ToastProvider } from '#/components/ToastProvider';
import { MonadStoreProvider } from '#/lib/monad-runtime-provider';
import '../styles/globals.css';
import '../features/routes/workspace/workspace.css';

const DevToolsWidget =
  process.env.NODE_ENV === 'production'
    ? null
    : dynamic(() => import('#/features/shell/DevToolsWidget').then((m) => m.DevToolsWidget), {
        ssr: false
      });

configureBuiltinExternalAgentObservationAdapters();

export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <Head>
        <title>Monad</title>
        <meta
          content=""
          name="description"
        />
        <link
          href="/favicon.svg"
          rel="icon"
          type="image/svg+xml"
        />
        <link
          href="/favicon.ico"
          rel="icon"
          sizes="any"
        />
      </Head>
      <MonadStoreProvider>
        <I18nProvider>
          <ToastProvider>
            <TooltipProvider delayDuration={200}>
              <Component {...pageProps} />
              {DevToolsWidget ? <DevToolsWidget /> : null}
            </TooltipProvider>
          </ToastProvider>
        </I18nProvider>
      </MonadStoreProvider>
    </>
  );
}
