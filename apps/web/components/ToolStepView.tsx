'use client';

import { cn } from '@monad/ui';
import { ExternalLink, FileText, Terminal } from 'lucide-react';
import { memo } from 'react';

import { CodeInline } from '@/components/ai-elements/code-block';
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput, type ToolPart } from '@/components/ai-elements/tool';
import { useT } from './I18nProvider';

export interface ToolItem {
  kind: 'tool';
  id: string;
  tool: string;
  input?: unknown;
  status: 'running' | 'ok' | 'error';
  output?: string;
  display?: unknown;
}

export interface ToolGroupItem {
  kind: 'toolGroup';
  id: string;
  steps: ToolItem[];
}

export type ToolViewItem = ToolItem | ToolGroupItem;

function summarizeArgs(input: unknown): string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return String(input ?? '');
  const obj = input as Record<string, unknown>;
  for (const k of ['path', 'command', 'query', 'url', 'name', 'id', 'key', 'text', 'prompt', 'input']) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v.length > 80 ? `${v.slice(0, 77)}…` : v;
  }
  for (const v of Object.values(obj)) {
    if (typeof v === 'string' && v.length > 0) return v.length > 80 ? `${v.slice(0, 77)}…` : v;
  }
  return JSON.stringify(obj);
}

/** Parse web_search tool output — handles both the DDG/Brave `{ provider, results }` shape
 *  and the Anthropic native `web_search_result[]` shape. */
function parseWebSearchOutput(raw: string | undefined): Array<{ title: string; url: string; snippet: string }> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    // DDG / Brave: { provider: string; results: WebSearchResult[] }
    if (
      parsed &&
      typeof parsed === 'object' &&
      'results' in parsed &&
      Array.isArray((parsed as { results: unknown }).results)
    ) {
      return (parsed as { results: Array<{ title?: string; url?: string; snippet?: string }> }).results.map((r) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: r.snippet ?? ''
      }));
    }
    // Anthropic native: web_search_result[] array
    if (Array.isArray(parsed)) {
      const items = parsed as Array<{ type?: string; title?: string | null; url?: string; pageAge?: string | null }>;
      if (items.every((r) => r.type === 'web_search_result' || r.url)) {
        return items.map((r) => ({ title: r.title ?? '', url: r.url ?? '', snippet: r.pageAge ?? '' }));
      }
    }
  } catch {
    // not JSON — fall through
  }
  return null;
}

/** Reject javascript: URLs before rendering as anchor href. */
function safeUrl(url: string): string {
  try {
    const { protocol } = new URL(url);
    return protocol === 'javascript:' ? '#' : url;
  } catch {
    return '#';
  }
}

interface ShellOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

interface DiffDisplay {
  type: 'diff';
  path: string;
  beforeText: string | null;
  afterText: string;
  diff?: string;
  diffStat?: { added: number; removed: number };
}

interface AnsiState {
  color?: string;
  bold: boolean;
  dim: boolean;
}

interface AnsiSegment {
  key: string;
  text: string;
  className?: string;
}

const ANSI_COLOR_CLASSES: Record<number, string> = {
  30: 'text-zinc-300',
  31: 'text-red-300',
  32: 'text-emerald-300',
  33: 'text-yellow-300',
  34: 'text-info',
  35: 'text-fuchsia-300',
  36: 'text-cyan-300',
  37: 'text-zinc-100',
  90: 'text-zinc-500',
  91: 'text-red-200',
  92: 'text-emerald-200',
  93: 'text-yellow-200',
  94: 'text-info',
  95: 'text-fuchsia-200',
  96: 'text-cyan-200',
  97: 'text-foreground'
};

function parseJsonOutput(raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function parseShellOutput(raw: string | undefined): ShellOutput | null {
  const parsed = parseJsonOutput(raw);
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Partial<ShellOutput>;
  if (typeof obj.stdout !== 'string' || typeof obj.stderr !== 'string') return null;
  if (typeof obj.exitCode !== 'number' || typeof obj.timedOut !== 'boolean') return null;
  return { stdout: obj.stdout, stderr: obj.stderr, exitCode: obj.exitCode, timedOut: obj.timedOut };
}

function parseAnsiText(text: string, baseClassName?: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  const state: AnsiState = { bold: false, dim: false };
  const pattern = new RegExp(`${String.fromCharCode(27)}\\[([0-9;]*)m`, 'g');
  let cursor = 0;
  let match: RegExpExecArray | null;

  const className = () => cn(baseClassName, state.color, state.bold && 'font-semibold', state.dim && 'opacity-70');
  const pushText = (value: string, start: number) => {
    if (value)
      segments.push({ key: `${start}-${value.length}-${segments.length}`, text: value, className: className() });
  };

  for (;;) {
    match = pattern.exec(text);
    if (!match) break;
    pushText(text.slice(cursor, match.index), cursor);
    cursor = pattern.lastIndex;
    const codes = match[1] ? match[1].split(';').map((code) => Number.parseInt(code, 10)) : [0];
    for (const code of codes) {
      if (!Number.isFinite(code) || code === 0) {
        state.color = undefined;
        state.bold = false;
        state.dim = false;
      } else if (code === 1) {
        state.bold = true;
      } else if (code === 2) {
        state.dim = true;
      } else if (code === 22) {
        state.bold = false;
        state.dim = false;
      } else if (code === 39) {
        state.color = undefined;
      } else if (ANSI_COLOR_CLASSES[code]) {
        state.color = ANSI_COLOR_CLASSES[code];
      }
    }
  }

  pushText(text.slice(cursor), cursor);
  return segments;
}

function parsedJsonObject(raw: string | undefined): unknown {
  const parsed = parseJsonOutput(raw);
  return parsed && typeof parsed === 'object' ? parsed : undefined;
}

function isFileReadTool(tool: string): boolean {
  return tool === 'fs_read' || tool === 'file_read' || tool === 'read_file';
}

function isShellTool(tool: string): boolean {
  return tool === 'shell_exec' || tool === 'shell' || tool === 'exec_command';
}

function parseDiffDisplay(display: unknown): DiffDisplay | null {
  if (!display || typeof display !== 'object') return null;
  const value = display as Partial<DiffDisplay>;
  if (value.type !== 'diff' || typeof value.path !== 'string' || typeof value.afterText !== 'string') return null;
  if (value.beforeText !== null && typeof value.beforeText !== 'string') return null;
  if (value.diff !== undefined && typeof value.diff !== 'string') return null;
  return {
    type: 'diff',
    path: value.path,
    beforeText: value.beforeText,
    afterText: value.afterText,
    diff: value.diff,
    diffStat: value.diffStat
  };
}

function firstStringField(input: unknown, keys: string[]): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const obj = input as Record<string, unknown>;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value;
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value.join(' ');
  }
  return undefined;
}

function toolState(status: ToolItem['status']): ToolPart['state'] {
  return status === 'running' ? 'input-available' : status === 'error' ? 'output-error' : 'output-available';
}

function groupStatus(steps: ToolItem[]): ToolItem['status'] {
  if (steps.some((step) => step.status === 'running')) return 'running';
  if (steps.some((step) => step.status === 'error')) return 'error';
  return 'ok';
}

export const ToolStepView = memo(function ToolStepView({ step }: { step: ToolViewItem }) {
  if (step.kind === 'toolGroup') return <ToolGroupView step={step} />;
  return <SingleToolView step={step} />;
});

function SingleToolView({ step }: { step: ToolItem }) {
  const t = useT();
  const isError = step.status === 'error';

  return (
    <Tool
      className={cn('panel-subtle mb-0 w-full self-start text-xs', isError && 'border-destructive/40 bg-destructive/5')}
      defaultOpen
    >
      <ToolHeader
        className="px-4 py-3"
        state={toolState(step.status)}
        title={step.input !== undefined ? `${step.tool} · ${summarizeArgs(step.input)}` : step.tool}
        type={`tool-${step.tool}` as `tool-${string}`}
      />
      <ToolContent className="border-border/70 border-t px-4 py-3">
        <ToolDetails
          pendingLabel={t('web.tools.running')}
          step={step}
        />
      </ToolContent>
    </Tool>
  );
}

function ToolGroupView({ step }: { step: ToolGroupItem }) {
  const t = useT();
  const status = groupStatus(step.steps);
  const isError = status === 'error';

  return (
    <Tool
      className={cn('panel-subtle mb-0 w-full self-start text-xs', isError && 'border-destructive/40 bg-destructive/5')}
      defaultOpen
    >
      <ToolHeader
        className="px-4 py-3"
        state={toolState(status)}
        title={t('web.tools.concurrentCalls', { count: step.steps.length })}
        type="tool-parallel"
      />
      <ToolContent className="border-border/70 border-t px-4 py-3">
        <div className="flex flex-col gap-3">
          {step.steps.map((child) => (
            <NestedToolView
              key={child.id}
              pendingLabel={t('web.tools.running')}
              step={child}
            />
          ))}
        </div>
      </ToolContent>
    </Tool>
  );
}

function NestedToolView({ step, pendingLabel }: { step: ToolItem; pendingLabel: string }) {
  return (
    <Tool
      className={cn(
        'mb-0 rounded-md border-border/70 bg-background/55',
        step.status === 'error' && 'border-destructive/30 bg-destructive/5'
      )}
      defaultOpen={step.status !== 'ok'}
    >
      <ToolHeader
        className="px-3 py-2"
        state={toolState(step.status)}
        title={step.input !== undefined ? `${step.tool} · ${summarizeArgs(step.input)}` : step.tool}
        type={`tool-${step.tool}` as `tool-${string}`}
      />
      <ToolContent className="border-border/60 border-t px-3 py-2">
        <ToolDetails
          pendingLabel={pendingLabel}
          step={step}
        />
      </ToolContent>
    </Tool>
  );
}

function ToolDetails({ step, pendingLabel }: { step: ToolItem; pendingLabel: string }) {
  const isError = step.status === 'error';
  const isWebSearch = step.tool === 'web_search';
  const searchResults = isWebSearch ? parseWebSearchOutput(step.output) : null;
  const shellOutput = isShellTool(step.tool) ? parseShellOutput(step.output) : null;
  const diffDisplay = parseDiffDisplay(step.display);

  if (isWebSearch && searchResults) {
    return (
      <>
        {step.input !== undefined && <ToolInput input={step.input} />}
        <WebSearchResults
          isError={isError}
          results={searchResults}
        />
        {step.status === 'running' && !step.output && <ToolPending label={pendingLabel} />}
      </>
    );
  }

  if (shellOutput) {
    return (
      <>
        {step.input !== undefined && <ToolInput input={step.input} />}
        <ShellOutputBlock
          command={firstStringField(step.input, ['command'])}
          output={shellOutput}
        />
      </>
    );
  }

  if (diffDisplay && !isError) {
    return (
      <>
        {step.input !== undefined && <ToolInput input={step.input} />}
        <FileDiffOutputBlock display={diffDisplay} />
      </>
    );
  }

  if (isFileReadTool(step.tool) && step.output !== undefined && !isError) {
    return (
      <>
        {step.input !== undefined && <ToolInput input={step.input} />}
        <FileReadOutputBlock
          output={step.output}
          path={firstStringField(step.input, ['path'])}
        />
      </>
    );
  }

  return (
    <>
      {step.input !== undefined && <ToolInput input={step.input} />}
      {step.status === 'running' && !step.output ? (
        <ToolPending label={pendingLabel} />
      ) : (
        <ToolOutput
          errorText={isError ? step.output : undefined}
          output={isError ? undefined : (parsedJsonObject(step.output) ?? step.output)}
        />
      )}
    </>
  );
}

function ToolPending({ label }: { label: string }) {
  return <div className="rounded-md bg-muted/50 px-3 py-2 text-muted-foreground text-xs">{label}</div>;
}

function ShellOutputBlock({ output, command }: { output: ShellOutput; command?: string }) {
  const hasStdout = output.stdout.length > 0;
  const hasStderr = output.stderr.length > 0;
  const stdout = parseAnsiText(output.stdout);
  const stderr = parseAnsiText(output.stderr, 'text-red-300');
  return (
    <div className="overflow-hidden rounded-md border border-border/70 bg-zinc-950 text-zinc-100 shadow-inner">
      <div className="flex items-center gap-2 border-zinc-800 border-b bg-zinc-900 px-3 py-2 text-[11px] text-zinc-400">
        <Terminal className="size-3.5" />
        {command ? <ShellCommand command={command} /> : <span className="min-w-0 truncate font-mono">terminal</span>}
        <span
          className={cn(
            'ml-auto rounded-full px-2 py-0.5 font-mono',
            output.exitCode === 0 && !output.timedOut
              ? 'bg-emerald-500/15 text-emerald-300'
              : 'bg-red-500/15 text-red-300'
          )}
        >
          {output.timedOut ? 'timed out' : `exit ${output.exitCode}`}
        </span>
      </div>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap p-3 font-mono text-[12px] leading-relaxed">
        {hasStdout || hasStderr ? (
          <>
            {hasStdout && <AnsiText segments={stdout} />}
            {hasStdout && hasStderr && '\n'}
            {hasStderr && <AnsiText segments={stderr} />}
          </>
        ) : (
          <span className="text-zinc-500">(no output)</span>
        )}
      </pre>
    </div>
  );
}

function ShellCommand({ command }: { command: string }) {
  return (
    <span className="min-w-0 truncate">
      <CodeInline
        className="[&_span]:!bg-transparent [&_span]:!text-[var(--shiki-dark)] text-[11px]"
        code={`$ ${command}`}
        language="bash"
      />
    </span>
  );
}

function AnsiText({ segments }: { segments: AnsiSegment[] }) {
  return (
    <>
      {segments.map((segment) => (
        <span
          className={segment.className}
          key={segment.key}
        >
          {segment.text}
        </span>
      ))}
    </>
  );
}

function FileReadOutputBlock({ output, path }: { output: string; path?: string }) {
  return (
    <div className="overflow-hidden rounded-md border border-border/70 bg-background">
      <div className="flex items-center gap-2 border-border/70 border-b bg-muted/50 px-3 py-2 text-muted-foreground text-xs">
        <FileText className="size-3.5" />
        <span className="min-w-0 truncate font-mono">{path ?? 'file'}</span>
      </div>
      <pre className="max-h-80 overflow-auto whitespace-pre p-3 font-mono text-[12px] text-foreground leading-relaxed">
        {output}
      </pre>
    </div>
  );
}

function FileDiffOutputBlock({ display }: { display: DiffDisplay }) {
  const diff = display.diff ?? display.afterText;
  const added =
    display.diffStat?.added ??
    diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
  const removed =
    display.diffStat?.removed ??
    diff.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---')).length;
  const occurrences = new Map<string, number>();
  const lines = diff.split('\n').map((line) => {
    const count = occurrences.get(line) ?? 0;
    occurrences.set(line, count + 1);
    return { key: `${line}-${count}`, line };
  });

  return (
    <div className="overflow-hidden rounded-md border border-border/70 bg-background">
      <div className="flex items-center gap-2 border-border/70 border-b bg-muted/50 px-3 py-2 text-muted-foreground text-xs">
        <FileText className="size-3.5" />
        <span className="min-w-0 truncate font-mono">{display.path}</span>
        <span className="ml-auto shrink-0 font-mono text-[11px]">
          <span className="text-emerald-500">+{added}</span>
          <span className="mx-1 text-muted-foreground/50">/</span>
          <span className="text-red-500">-{removed}</span>
        </span>
      </div>
      <pre className="max-h-80 overflow-auto whitespace-pre p-3 font-mono text-[12px] leading-relaxed">
        {lines.map(({ key, line }) => (
          <span
            className={cn(
              'block min-h-[1.35em]',
              line.startsWith('+') &&
                !line.startsWith('+++') &&
                'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
              line.startsWith('-') && !line.startsWith('---') && 'bg-red-500/10 text-red-700 dark:text-red-300',
              (line.startsWith('@@') || line.startsWith('---') || line.startsWith('+++')) && 'text-muted-foreground'
            )}
            key={key}
          >
            {line || ' '}
          </span>
        ))}
      </pre>
    </div>
  );
}

const WebSearchResults = memo(function WebSearchResults({
  results,
  isError
}: {
  results: Array<{ title: string; url: string; snippet: string }>;
  isError: boolean;
}) {
  const t = useT();
  if (isError || results.length === 0) {
    return (
      <div className="px-4 py-3 text-muted-foreground/60 text-xs">
        {isError ? t('web.tools.searchFailed') : t('web.tools.noResults')}
      </div>
    );
  }
  return (
    <div className="divide-y">
      {results.map((r) => {
        let hostname = '';
        try {
          hostname = new URL(r.url).hostname.replace(/^www\./, '');
        } catch {
          hostname = r.url;
        }
        return (
          <div
            className="px-4 py-3"
            key={r.url}
          >
            <div className="flex items-start gap-1.5">
              <div className="min-w-0 flex-1">
                <a
                  className="flex items-center gap-1 font-medium text-foreground/80 text-xs hover:text-foreground hover:underline"
                  href={safeUrl(r.url)}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  <span className="truncate">{r.title || hostname}</span>
                  <ExternalLink className="size-2.5 shrink-0 text-muted-foreground/40" />
                </a>
                <div className="mt-0.5 truncate text-[10px] text-muted-foreground/50">{hostname}</div>
                {r.snippet && (
                  <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground/70 leading-relaxed">{r.snippet}</p>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
});
