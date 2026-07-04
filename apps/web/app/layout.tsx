import type { Metadata } from 'next';

import Script from 'next/script';
import './globals.css';

import { TooltipProvider } from '@monad/ui';

import { AppProviders } from '@/app/Providers';

export const metadata: Metadata = {
  title: 'monad',
  description: 'monad agent interface'
};

const launchEditorPathFix =
  process.env.NODE_ENV === 'production'
    ? null
    : `(()=>{const originalFetch=window.fetch.bind(window);function normalize(file){if(!file)return file;for(const prefix of ['./apps/web/','apps/web/','/apps/web/']){if(file.startsWith(prefix))return './'+file.slice(prefix.length)}return file}function rewrite(input){try{const url=new URL(input,location.origin);if(url.origin!==location.origin||url.pathname!=='/__nextjs_launch-editor')return null;const file=url.searchParams.get('file');const normalized=normalize(file);if(!normalized||normalized===file)return null;url.searchParams.set('file',normalized);return url.pathname+url.search}catch{return null}}window.fetch=(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input instanceof Request?input.url:null;const rewritten=url?rewrite(url):null;if(!rewritten)return originalFetch(input,init);if(input instanceof Request)return originalFetch(new Request(rewritten,input),init);return originalFetch(rewritten,init)}})()`;

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
        {launchEditorPathFix ? (
          <Script
            // biome-ignore lint/security/noDangerouslySetInnerHtml: static dev-only Next overlay path normalization
            dangerouslySetInnerHTML={{ __html: launchEditorPathFix }}
            id="next-launch-editor-path-fix"
            strategy="beforeInteractive"
          />
        ) : null}
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
