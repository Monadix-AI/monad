import type { Metadata } from 'next';

import Script from 'next/script';
import './globals.css';

import { TooltipProvider } from '@monad/ui';

import { AppProviders } from '@/app/Providers';

export const metadata: Metadata = {
  title: 'monad',
  description: 'monad agent interface'
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  let devToolsWidget: React.ReactNode = null;
  if (process.env.NODE_ENV !== 'production') {
    const { DevToolsWidget } = await import('@/features/shell/DevToolsWidget');
    devToolsWidget = <DevToolsWidget />;
  }

  return (
    <html
      className="h-full"
      lang="en"
      suppressHydrationWarning
    >
      <head>
        {/* Apply the saved theme before paint so there's no light→dark flash. */}
        <Script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: tiny static snippet, no user input
          dangerouslySetInnerHTML={{
            __html: `(()=>{try{const s=localStorage.getItem('monad:theme');const d=s?s==='dark':matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.classList.toggle('dark',d)}catch{}})()`
          }}
          id="theme-init"
          strategy="beforeInteractive"
        />
        <Script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: tiny static snippet, no user input
          dangerouslySetInnerHTML={{
            __html: `(()=>{try{document.documentElement.classList.toggle('monad-interactive-cursor', localStorage.getItem('monad:interactiveCursor')==='true')}catch{}})()`
          }}
          id="interactive-cursor-init"
          strategy="beforeInteractive"
        />
        <Script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: tiny static snippet, no user input
          dangerouslySetInnerHTML={{
            __html: `(()=>{const d=document.documentElement;const k=new Set(['Tab','ArrowUp','ArrowRight','ArrowDown','ArrowLeft','Home','End','PageUp','PageDown']);d.setAttribute('data-input-modality','pointer');addEventListener('pointerdown',()=>d.setAttribute('data-input-modality','pointer'),true);addEventListener('keydown',e=>{if(k.has(e.key))d.setAttribute('data-input-modality','keyboard')},true)})()`
          }}
          id="input-modality-init"
          strategy="beforeInteractive"
        />
      </head>
      <body className="h-full overflow-hidden">
        <AppProviders>
          <TooltipProvider delayDuration={200}>
            {children}
            {devToolsWidget}
          </TooltipProvider>
        </AppProviders>
      </body>
    </html>
  );
}
