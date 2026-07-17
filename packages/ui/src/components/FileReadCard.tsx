import type { BundledLanguage } from 'shiki';

import { CodeBlock } from './CodeBlock';
import { ObservationMeta } from './ObservationCard';

export interface FileReadCardView {
  content: string;
  path: string;
  provider: string;
  type: string;
}

export function FileReadCard({ view }: { view: FileReadCardView }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{view.path}</div>
      <CodeBlock
        className="rounded-md border border-border/80 bg-background/80 text-[11px] [&>div::-webkit-scrollbar]:hidden [&>div]:max-h-72 [&>div]:overflow-auto [&>div]:[scrollbar-width:none] [&_pre]:p-0"
        code={view.content}
        language={languageFromPath(view.path)}
      />
    </div>
  );
}

export function FileReadCardHeader({ view }: { view: FileReadCardView }) {
  return (
    <ObservationMeta
      compact
      label="tool call"
      showSource={false}
      source={view.provider}
      title={view.type}
    />
  );
}

function languageFromPath(path: string): BundledLanguage {
  const suffix = path.split(/[?#]/, 1)[0]?.split('.').pop()?.toLowerCase();
  switch (suffix) {
    case 'cjs':
    case 'js':
    case 'jsx':
    case 'mjs':
      return 'javascript';
    case 'cts':
    case 'mts':
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'json':
    case 'jsonc':
      return 'json';
    case 'md':
    case 'mdx':
      return 'markdown';
    case 'css':
      return 'css';
    case 'html':
      return 'html';
    case 'py':
      return 'python';
    case 'rb':
      return 'ruby';
    case 'rs':
      return 'rust';
    case 'go':
      return 'go';
    case 'java':
      return 'java';
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'bash';
    case 'sql':
      return 'sql';
    case 'yaml':
    case 'yml':
      return 'yaml';
    default:
      return 'markdown';
  }
}
