import type { BundledLanguage } from 'shiki';

import { CodeBlock, CodeBlockCopyButtonOverlay } from './CodeBlock';
import { CompactFilePath } from './CompactFilePath';
import { FileIcon, fileBaseName } from './FileIcon';
import { ObservationMeta } from './ObservationCard';

export interface FileReadCardView {
  content: string;
  path: string;
  provider: string;
  type: string;
}

export function FileReadCard({
  copyCodeLabel,
  copyPathLabel,
  view
}: {
  copyCodeLabel?: string;
  copyPathLabel?: string;
  view: FileReadCardView;
}) {
  const content = fileReadDisplayContent(view.content, view.provider);
  return (
    <CodeBlock
      className="**:data-[slot=scroll-shadow]:scrollbar-none rounded-md border border-border/80 bg-background text-[11px] [--code-block-inline-padding:0.75rem] **:data-[slot=scroll-shadow]:max-h-72 [&_[data-slot=scroll-shadow]::-webkit-scrollbar]:hidden [&_pre]:py-2.5"
      code={content.code}
      copyLabel={copyCodeLabel}
      copyOverlayClassName="opacity-0 transition-opacity group-focus-within/code-block-content:opacity-100 group-hover/code-block-content:opacity-100"
      language={languageFromPath(view.path)}
      lineNumbers={content.lineNumbers}
      scrollShadow
      scrollShadowSize={14}
      showLineNumbers={fileReadShowsGeneratedLineNumbers(view.provider)}
    >
      <div
        className="group/file-read-path relative flex min-w-0 items-center gap-2 border-border/70 border-b px-3 py-2 font-ui text-[11px] text-muted-foreground"
        data-file-read-copy-target="path"
      >
        <FileIcon
          className="size-3.5 shrink-0"
          fileName={view.path}
        />
        <CompactFilePath
          className="flex-1"
          path={view.path}
        />
        {copyPathLabel ? (
          <CodeBlockCopyButtonOverlay
            aria-label={copyPathLabel}
            buttonClassName="border-0 bg-transparent hover:bg-background"
            className="pt-1 opacity-0 transition-opacity group-focus-within/file-read-path:opacity-100 group-hover/file-read-path:opacity-100"
            data-copy-target="path"
            value={view.path}
          />
        ) : null}
      </div>
    </CodeBlock>
  );
}

export function fileReadShowsGeneratedLineNumbers(provider: string): boolean {
  return provider !== 'claude-code' && provider !== 'claude-code-sdk';
}

export function fileReadDisplayContent(
  content: string,
  provider: string
): { code: string; lineNumbers?: readonly number[] } {
  if (fileReadShowsGeneratedLineNumbers(provider)) return { code: content };
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const parsed: Array<{ code: string; lineNumber: number }> = [];
  for (const line of lines) {
    const match = /^[ \u00a0]*(\d+)(?:[ \u00a0]*\u2192|\t)(.*)$/.exec(line);
    if (!match) break;
    parsed.push({ code: match[2] ?? '', lineNumber: Number(match[1]) });
  }
  if (
    parsed.length === 0 ||
    parsed.some((line, index) => index > 0 && line.lineNumber !== (parsed[index - 1]?.lineNumber ?? 0) + 1)
  )
    return { code: content };
  const trailingText = lines.slice(parsed.length).join('\n');
  const visibleTrailingText = stripTrailingSystemReminders(trailingText);
  const trailing = visibleTrailingText ? visibleTrailingText.split('\n') : [];
  return {
    code: [...parsed.map((line) => line.code), ...trailing].join('\n'),
    lineNumbers: parsed.map((line) => line.lineNumber)
  };
}

function stripTrailingSystemReminders(value: string): string {
  const lower = value.toLowerCase();
  const opening = '<system-reminder';
  const closing = '</system-reminder>';
  let end = value.length;
  while (end > 0 && /\s/u.test(value[end - 1] ?? '')) end -= 1;
  let removed = false;
  while (lower.slice(end - closing.length, end) === closing) {
    const closeStart = end - closing.length;
    const openStart = lower.lastIndexOf(opening, closeStart);
    if (openStart < 0) break;
    const boundary = lower[openStart + opening.length];
    if (boundary !== undefined && /[\p{L}\p{N}_]/u.test(boundary)) break;
    const openEnd = lower.indexOf('>', openStart + opening.length);
    if (openEnd < 0 || openEnd >= closeStart) break;
    removed = true;
    end = openStart;
    while (end > 0 && value[end - 1] === '\n') end -= 1;
  }
  return removed ? value.slice(0, end) : value;
}

export function FileReadCardHeader({
  quiet = false,
  title,
  view
}: {
  quiet?: boolean;
  title?: string;
  view: FileReadCardView;
}) {
  return (
    <ObservationMeta
      compact
      label="tool call"
      preserveTitle
      quiet={quiet}
      showSource={false}
      source={view.provider}
      title={title ?? view.type}
    >
      {quiet ? (
        <span
          className="flex min-w-0 flex-1 items-center gap-1.5 text-muted-foreground"
          data-slot="file-read-card-title-path-container"
        >
          <FileIcon
            className="size-3.5 shrink-0"
            fileName={view.path}
          />
          <span
            className="min-w-0 truncate"
            data-slot="file-read-card-title-path"
          >
            {fileBaseName(view.path)}
          </span>
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
