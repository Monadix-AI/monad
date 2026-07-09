import { Head, Html, Main, NextScript } from 'next/document';

const themeInit = `(()=>{try{const s=localStorage.getItem('monad:theme');const d=s==='dark'||((!s||s==='auto')&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d)}catch{}})()`;
const interactiveCursorInit = `(()=>{try{document.documentElement.classList.toggle('monad-interactive-cursor', localStorage.getItem('monad:interactiveCursor')==='true')}catch{}})()`;
const inputModalityInit = `(()=>{const d=document.documentElement;const k=new Set(['Tab','ArrowUp','ArrowRight','ArrowDown','ArrowLeft','Home','End','PageUp','PageDown']);d.setAttribute('data-input-modality','pointer');addEventListener('pointerdown',()=>d.setAttribute('data-input-modality','pointer'),true);addEventListener('keydown',e=>{if(k.has(e.key))d.setAttribute('data-input-modality','keyboard')},true)})()`;
const launchEditorPathFix =
  process.env.NODE_ENV === 'production'
    ? null
    : `(()=>{const originalFetch=window.fetch.bind(window);function normalize(file){if(!file)return file;for(const prefix of ['./apps/web/','apps/web/','/apps/web/']){if(file.startsWith(prefix))return './'+file.slice(prefix.length)}return file}function rewrite(input){try{const url=new URL(input,location.origin);if(url.origin!==location.origin||url.pathname!=='/__nextjs_launch-editor')return null;const file=url.searchParams.get('file');const normalized=normalize(file);if(!normalized||normalized===file)return null;url.searchParams.set('file',normalized);return url.pathname+url.search}catch{return null}}window.fetch=(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input instanceof Request?input.url:null;const rewritten=url?rewrite(url):null;if(!rewritten)return originalFetch(input,init);if(input instanceof Request)return originalFetch(new Request(rewritten,input),init);return originalFetch(rewritten,init)}})()`;

export default function Document() {
  return (
    <Html
      className="h-full"
      lang="en"
      suppressHydrationWarning
    >
      <Head>
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: tiny static snippet, no user input
          dangerouslySetInnerHTML={{ __html: themeInit }}
          id="theme-init"
        />
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: tiny static snippet, no user input
          dangerouslySetInnerHTML={{ __html: interactiveCursorInit }}
          id="interactive-cursor-init"
        />
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: tiny static snippet, no user input
          dangerouslySetInnerHTML={{ __html: inputModalityInit }}
          id="input-modality-init"
        />
        {launchEditorPathFix ? (
          <script
            // biome-ignore lint/security/noDangerouslySetInnerHtml: static dev-only Next overlay path normalization
            dangerouslySetInnerHTML={{ __html: launchEditorPathFix }}
            id="next-launch-editor-path-fix"
          />
        ) : null}
      </Head>
      <body className="h-full overflow-hidden">
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
