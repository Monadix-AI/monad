import type { BundledLanguage } from 'shiki';

import { CodeBlock } from './CodeBlock';
import { FileIcon } from './FileIcon';
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
      <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
        <FileIcon
          className="size-3.5 shrink-0"
          fileName={view.path}
        />
        <span className="min-w-0 truncate">{view.path}</span>
      </div>
      <CodeBlock
        className="rounded-md border border-border/80 bg-background/80 text-[11px] [&>div::-webkit-scrollbar]:hidden [&>div]:max-h-72 [&>div]:overflow-auto [&>div]:[scrollbar-width:none] [&_pre]:p-0"
        code={view.content}
        language={languageFromPath(view.path)}
      />
    </div>
  );
}

export function FileReadCardHeader({ quiet = false, view }: { quiet?: boolean; view: FileReadCardView }) {
  return (
    <ObservationMeta
      compact
      label="tool call"
      quiet={quiet}
      showSource={false}
      source={view.provider}
      title={view.type}
    >
      {quiet ? (
        <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground">
          <FileIcon
            className="size-3.5 shrink-0"
            fileName={view.path}
          />
          <span className="min-w-0 truncate">{view.path}</span>
        </span>
      ) : null}
    </ObservationMeta>
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
