'use client';

import type { SessionId } from '@monad/protocol';
import type { ToolPart } from '@monad/ui';

import { ComputerTerminal01Icon, ExternalLinkIcon, SquareIcon, TextIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button, cn, Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@monad/ui';
import { CodeInline } from '@monad/ui/components/CodeBlock';
import { memo, useMemo, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { useToolBackendsSettings } from '#/hooks/use-tool-backends-settings';

export interface ToolItem {
  kind: 'tool';
  id: string;
  tool: string;
  input?: unknown;
  status: 'running' | 'ok' | 'error';
  output?: string;
  errorCode?: string;
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
  exitCode: number | null;
  timedOut: boolean;
  status?: string;
  command?: string;
  cwd?: string;
  pid?: number;
  processId?: string;
  mode?: string;
  startedAt?: string;
  limits?: { idleTimeoutMs?: number; maxRuntimeMs?: number };
  matched?: boolean;
  reason?: string;
}

interface CodeExecOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
  backend?: string;
}

interface DiffDisplay {
  type: 'diff';
  path: string;
  beforeText: string | null;
  afterText: string;
  diff?: string;
  diffStat?: { added: number; removed: number };
  warning?: string;
}

interface MultiDiffDisplay {
  type: 'multi_diff';
  summary?: { added: number; removed: number; succeeded: number; failed: number; total: number; warnings?: number };
  files: Array<{
    path: string;
    status: 'ok' | 'error';
    display?: DiffDisplay;
    error?: string;
    operation?: string;
    newPath?: string;
  }>;
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
  const exitCode = typeof obj.exitCode === 'number' || obj.exitCode === null ? obj.exitCode : null;
  const timedOut = typeof obj.timedOut === 'boolean' ? obj.timedOut : false;
  return {
    stdout: obj.stdout,
    stderr: obj.stderr,
    exitCode,
    timedOut,
    status: typeof obj.status === 'string' ? obj.status : undefined,
    command: typeof obj.command === 'string' ? obj.command : undefined,
    cwd: typeof obj.cwd === 'string' ? obj.cwd : undefined,
    pid: typeof obj.pid === 'number' ? obj.pid : undefined,
    processId: typeof obj.processId === 'string' ? obj.processId : undefined,
    mode: typeof obj.mode === 'string' ? obj.mode : undefined,
    startedAt: typeof obj.startedAt === 'string' ? obj.startedAt : undefined,
    limits: parseShellLimits(obj.limits),
    matched:
      typeof (obj as { matched?: unknown }).matched === 'boolean' ? (obj as { matched: boolean }).matched : undefined,
    reason: typeof (obj as { reason?: unknown }).reason === 'string' ? (obj as { reason: string }).reason : undefined
  };
}

function parseShellLimits(value: unknown): ShellOutput['limits'] {
  if (!value || typeof value !== 'object') return undefined;
  const limits = value as { idleTimeoutMs?: unknown; maxRuntimeMs?: unknown };
  return {
    ...(typeof limits.idleTimeoutMs === 'number' ? { idleTimeoutMs: limits.idleTimeoutMs } : {}),
    ...(typeof limits.maxRuntimeMs === 'number' ? { maxRuntimeMs: limits.maxRuntimeMs } : {})
  };
}

function parseCodeExecOutput(raw: string | undefined): CodeExecOutput | null {
  const parsed = parseJsonOutput(raw);
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Partial<CodeExecOutput>;
  if (typeof obj.stdout !== 'string' || typeof obj.stderr !== 'string') return null;
  if (typeof obj.exitCode !== 'number') return null;
  return {
    stdout: obj.stdout,
    stderr: obj.stderr,
    exitCode: obj.exitCode,
    backend: typeof obj.backend === 'string' ? obj.backend : undefined
  };
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
  return tool === 'file_read';
}

function isShellTool(tool: string): boolean {
  return (
    tool === 'shell_exec' ||
    tool === 'process_control' ||
    tool === 'monitor_watch' ||
    tool === 'shell' ||
    tool === 'exec_command'
  );
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
    diffStat: value.diffStat,
    warning: typeof value.warning === 'string' ? value.warning : undefined
  };
}

function parseMultiDiffDisplay(display: unknown): MultiDiffDisplay | null {
  if (!display || typeof display !== 'object') return null;
  const value = display as Partial<MultiDiffDisplay>;
  if (value.type !== 'multi_diff' || !Array.isArray(value.files)) return null;
  const files = value.files
    .map((file): MultiDiffDisplay['files'][number] | null => {
      if (!file || typeof file !== 'object') return null;
      const entry = file as MultiDiffDisplay['files'][number];
      if (typeof entry.path !== 'string' || (entry.status !== 'ok' && entry.status !== 'error')) return null;
      const display = parseDiffDisplay(entry.display);
      if (entry.status === 'ok' && !display) return null;
      if (entry.status === 'error' && typeof entry.error !== 'string') return null;
      return {
        path: entry.path,
        status: entry.status,
        ...(display ? { display } : {}),
        ...(typeof entry.error === 'string' ? { error: entry.error } : {}),
        ...(typeof entry.operation === 'string' ? { operation: entry.operation } : {}),
        ...(typeof entry.newPath === 'string' ? { newPath: entry.newPath } : {})
      };
    })
    .filter((file): file is MultiDiffDisplay['files'][number] => file !== null);
  const summary =
    value.summary &&
    typeof value.summary === 'object' &&
    typeof value.summary.added === 'number' &&
    typeof value.summary.removed === 'number' &&
    typeof value.summary.succeeded === 'number' &&
    typeof value.summary.failed === 'number' &&
    typeof value.summary.total === 'number'
      ? {
          ...value.summary,
          ...(typeof value.summary.warnings === 'number' ? { warnings: value.summary.warnings } : {})
        }
      : undefined;
  return files.length > 0 ? { type: 'multi_diff', files, ...(summary ? { summary } : {}) } : null;
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

export const ToolStepView = memo(function ToolStepView({
  sessionId,
  step
}: {
  sessionId?: SessionId;
  step: ToolViewItem;
}) {
  if (step.kind === 'toolGroup')
    return (
      <ToolGroupView
        sessionId={sessionId}
        step={step}
      />
    );
  return (
    <SingleToolView
      sessionId={sessionId}
      step={step}
    />
  );
});

function SingleToolView({ step, sessionId }: { step: ToolItem; sessionId?: SessionId }) {
  const t = useT();
  const isError = step.status === 'error';

  return (
    <Tool
      className={cn('mb-1 w-full self-start text-xs', isError && 'border-destructive/40')}
      defaultOpen
    >
      <ToolHeader
        state={toolState(step.status)}
        title={step.input !== undefined ? `${step.tool} · ${summarizeArgs(step.input)}` : step.tool}
        type={`tool-${step.tool}` as `tool-${string}`}
      />
      <ToolContent>
        <ToolDetails
          pendingLabel={t('web.tools.running')}
          sessionId={sessionId}
          step={step}
        />
      </ToolContent>
    </Tool>
  );
}

function ToolGroupView({ step, sessionId }: { step: ToolGroupItem; sessionId?: SessionId }) {
  const t = useT();
  const status = groupStatus(step.steps);
  const isError = status === 'error';

  return (
    <Tool
      className={cn('mb-1 w-full self-start text-xs', isError && 'border-destructive/40')}
      defaultOpen
    >
      <ToolHeader
        state={toolState(status)}
        title={t('web.tools.concurrentCalls', { count: step.steps.length })}
        type="tool-parallel"
      />
      <ToolContent>
        <div className="flex flex-col gap-3">
          {step.steps.map((child) => (
            <NestedToolView
              key={child.id}
              pendingLabel={t('web.tools.running')}
              sessionId={sessionId}
              step={child}
            />
          ))}
        </div>
      </ToolContent>
    </Tool>
  );
}

function NestedToolView({
  step,
  pendingLabel,
  sessionId
}: {
  step: ToolItem;
  pendingLabel: string;
  sessionId?: SessionId;
}) {
  return (
    <Tool
      className={cn('mb-0 text-xs', step.status === 'error' && 'border-destructive/30')}
      defaultOpen={step.status !== 'ok'}
    >
      <ToolHeader
        state={toolState(step.status)}
        title={step.input !== undefined ? `${step.tool} · ${summarizeArgs(step.input)}` : step.tool}
        type={`tool-${step.tool}` as `tool-${string}`}
      />
      <ToolContent>
        <ToolDetails
          pendingLabel={pendingLabel}
          sessionId={sessionId}
          step={step}
        />
      </ToolContent>
    </Tool>
  );
}

function ToolDetails({
  step,
  pendingLabel,
  sessionId: _sessionId
}: {
  step: ToolItem;
  pendingLabel: string;
  sessionId?: SessionId;
}) {
  const isError = step.status === 'error';
  const stoppingProcess = false;
  const isWebSearch = step.tool === 'web_search';
  const isShell = isShellTool(step.tool);
  const searchResults = useMemo(
    () => (isWebSearch ? parseWebSearchOutput(step.output) : null),
    [isWebSearch, step.output]
  );
  // step.output grows on every poll tick for a live background process — memoize so an unchanged
  // tick doesn't re-run JSON.parse + full ANSI re-segmentation of the whole accumulated output.
  const shellOutput = useMemo(() => (isShell ? parseShellOutput(step.output) : null), [isShell, step.output]);

  if (step.tool === 'code_execute') {
    return (
      <CodeExecDetails
        isError={isError}
        pendingLabel={pendingLabel}
        step={step}
      />
    );
  }

  const diffDisplay = parseDiffDisplay(step.display);
  const multiDiffDisplay = parseMultiDiffDisplay(step.display);

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
          command={firstStringField(step.input, ['command']) ?? shellOutput.command}
          onStop={undefined}
          output={shellOutput}
          stopping={stoppingProcess}
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

  if (multiDiffDisplay && !isError) {
    return (
      <>
        {step.input !== undefined && <ToolInput input={step.input} />}
        <MultiFileDiffOutputBlock display={multiDiffDisplay} />
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
          errorText={isError ? formatToolError(step.output, step.errorCode) : undefined}
          output={isError ? undefined : (parsedJsonObject(step.output) ?? step.output)}
        />
      )}
    </>
  );
}

function backendLabel(backend: string): string {
  if (backend === 'follow-system') return 'system sandbox';
  if (backend === 'e2b') return 'E2B';
  return backend;
}

function CodeExecDetails({ step, pendingLabel, isError }: { step: ToolItem; pendingLabel: string; isError: boolean }) {
  const { config } = useToolBackendsSettings();
  const output = useMemo(() => parseCodeExecOutput(step.output), [step.output]);
  const backend = output?.backend ?? config?.codeExec?.backend ?? 'follow-system';
  const input = step.input as Record<string, unknown> | null;
  const language = typeof input?.language === 'string' ? input.language : undefined;
  const code = typeof input?.code === 'string' ? input.code : undefined;
  const isHost = input?.target === 'host';
  const hasStdout = (output?.stdout.length ?? 0) > 0;
  const hasStderr = (output?.stderr.length ?? 0) > 0;
  const stdoutSegments = useMemo(() => (output?.stdout ? parseAnsiText(output.stdout) : []), [output?.stdout]);
  const stderrSegments = useMemo(
    () => (output?.stderr ? parseAnsiText(output.stderr, 'text-red-300') : []),
    [output?.stderr]
  );

  return (
    <div className="flex flex-col gap-2">
      {code !== undefined && (
        <div className="overflow-hidden rounded-md border border-border/70 bg-zinc-950 text-zinc-100 shadow-inner">
          <div className="flex items-center gap-2 border-zinc-800 border-b bg-zinc-900 px-3 py-2 text-[11px] text-zinc-400">
            <HugeiconsIcon
              className="size-3.5"
              icon={ComputerTerminal01Icon}
            />
            <span className="font-mono">{language ?? 'code'}</span>
            <span className="rounded bg-zinc-700/60 px-1.5 py-0.5 font-mono text-[10px]">{backendLabel(backend)}</span>
            {isHost && (
              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-300">host</span>
            )}
          </div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap p-3 font-mono text-[12px] leading-relaxed">
            {code}
          </pre>
        </div>
      )}
      {step.status === 'running' && !step.output ? (
        <ToolPending label={pendingLabel} />
      ) : output && !isError ? (
        <div className="overflow-hidden rounded-md border border-border/70 bg-zinc-950 text-zinc-100 shadow-inner">
          <div className="flex items-center border-zinc-800 border-b bg-zinc-900 px-3 py-2 text-[11px]">
            <span
              className={cn(
                'ml-auto rounded-full px-2 py-0.5 font-mono',
                output.exitCode === 0 ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'
              )}
            >
              exit {output.exitCode}
            </span>
          </div>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap p-3 font-mono text-[12px] leading-relaxed">
            {hasStdout || hasStderr ? (
              <>
                {hasStdout && <AnsiText segments={stdoutSegments} />}
                {hasStdout && hasStderr && '\n'}
                {hasStderr && <AnsiText segments={stderrSegments} />}
              </>
            ) : (
              <span className="text-zinc-500">(no output)</span>
            )}
          </pre>
        </div>
      ) : (
        <ToolOutput
          errorText={isError ? formatToolError(step.output, step.errorCode) : undefined}
          output={isError ? undefined : (parsedJsonObject(step.output) ?? step.output)}
        />
      )}
    </div>
  );
}

function ToolPending({ label }: { label: string }) {
  return <div className="rounded-md bg-muted/50 px-3 py-2 text-muted-foreground text-xs">{label}</div>;
}

function formatToolError(output: string | undefined, code: string | undefined): string | undefined {
  if (!code) return output;
  return output ? `[${code}] ${output}` : `[${code}]`;
}

function ShellOutputBlock({
  output,
  command,
  onStop,
  stopping
}: {
  output: ShellOutput;
  command?: string;
  onStop?: () => void;
  stopping?: boolean;
}) {
  const hasStdout = output.stdout.length > 0;
  const hasStderr = output.stderr.length > 0;
  // output.stdout/stderr grow on every poll tick for a live background process — memoize so an
  // unchanged tick doesn't re-run the full ANSI re-segmentation of the whole accumulated output.
  const stdout = useMemo(() => parseAnsiText(output.stdout), [output.stdout]);
  const stderr = useMemo(() => parseAnsiText(output.stderr, 'text-red-300'), [output.stderr]);
  const isSuccess = output.exitCode === 0 && !output.timedOut;
  const badgeText = output.timedOut
    ? 'timed out'
    : output.matched === true && output.reason
      ? output.reason
      : output.exitCode === null
        ? (output.status ?? 'running')
        : `exit ${output.exitCode}`;
  const badgeClass = isSuccess
    ? 'bg-emerald-500/15 text-emerald-300'
    : output.matched === true && !output.timedOut
      ? 'bg-emerald-500/15 text-emerald-300'
      : output.exitCode === null && !output.timedOut
        ? 'bg-zinc-700/60 text-zinc-300'
        : 'bg-red-500/15 text-red-300';
  const limitLabels = [
    output.limits?.idleTimeoutMs !== undefined ? `idle ${output.limits.idleTimeoutMs}ms` : undefined,
    output.limits?.maxRuntimeMs !== undefined ? `max ${output.limits.maxRuntimeMs}ms` : undefined
  ].filter((label): label is string => label !== undefined);
  return (
    <div className="overflow-hidden rounded-md border border-border/70 bg-zinc-950 text-zinc-100 shadow-inner">
      <div className="flex items-center gap-2 border-zinc-800 border-b bg-zinc-900 px-3 py-2 text-[11px] text-zinc-400">
        <HugeiconsIcon
          className="size-3.5"
          icon={ComputerTerminal01Icon}
        />
        {command ? <ShellCommand command={command} /> : <span className="min-w-0 truncate font-mono">terminal</span>}
        {output.mode && (
          <span className="shrink-0 rounded bg-zinc-700/60 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">
            {output.mode}
          </span>
        )}
        {output.pid !== undefined && (
          <span className="shrink-0 rounded bg-zinc-700/60 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">
            pid {output.pid}
          </span>
        )}
        {onStop && (
          <Button
            aria-label="Stop process"
            className="ml-auto size-6 border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100"
            disabled={stopping}
            onClick={onStop}
            size="icon"
            title="Stop process"
            type="button"
            variant="outline"
          >
            <HugeiconsIcon
              className="size-3.5"
              icon={SquareIcon}
            />
          </Button>
        )}
        <span className={cn(onStop ? '' : 'ml-auto', 'rounded-full px-2 py-0.5 font-mono', badgeClass)}>
          {badgeText}
        </span>
      </div>
      {(output.cwd || output.startedAt || limitLabels.length > 0) && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 border-zinc-800 border-b bg-zinc-950 px-3 py-2 font-mono text-[10px] text-zinc-500">
          {output.cwd && <span className="min-w-0 truncate">cwd {output.cwd}</span>}
          {output.startedAt && <span>started {output.startedAt}</span>}
          {limitLabels.map((label) => (
            <span key={label}>{label}</span>
          ))}
        </div>
      )}
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
        className="text-[11px] [&_span]:bg-transparent! [&_span]:text-(--shiki-dark)!"
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
        <HugeiconsIcon
          className="size-3.5"
          icon={TextIcon}
        />
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
        <HugeiconsIcon
          className="size-3.5"
          icon={TextIcon}
        />
        <span className="min-w-0 truncate font-mono">{display.path}</span>
        {display.warning && (
          <span className="shrink-0 rounded bg-warning/10 px-1.5 py-0.5 font-mono text-[10px] text-warning">
            warning
          </span>
        )}
        <span className="ml-auto shrink-0 font-mono text-[11px]">
          <span className="text-emerald-500">+{added}</span>
          <span className="mx-1 text-muted-foreground/50">/</span>
          <span className="text-red-500">-{removed}</span>
        </span>
      </div>
      {display.warning && (
        <div className="border-warning/20 border-b bg-warning/5 px-3 py-2 text-[11px] text-warning">
          {display.warning}
        </div>
      )}
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

function MultiFileDiffOutputBlock({ display }: { display: MultiDiffDisplay }) {
  const [expanded, setExpanded] = useState(false);
  const summary =
    display.summary ??
    display.files.reduce(
      (acc, file) => ({
        added: acc.added + (file.display?.diffStat?.added ?? 0),
        removed: acc.removed + (file.display?.diffStat?.removed ?? 0),
        succeeded: acc.succeeded + (file.status === 'ok' ? 1 : 0),
        failed: acc.failed + (file.status === 'error' ? 1 : 0),
        total: acc.total + 1,
        warnings: acc.warnings + (file.display?.warning ? 1 : 0)
      }),
      { added: 0, removed: 0, succeeded: 0, failed: 0, total: 0, warnings: 0 }
    );
  const visibleFiles = useMemo(() => {
    if (expanded || display.files.length <= 4) return display.files;
    const firstFiles = new Set(display.files.slice(0, 3));
    return display.files.filter((file) => firstFiles.has(file) || file.status === 'error');
  }, [display.files, expanded]);
  const hiddenCount = display.files.length - visibleFiles.length;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 rounded-md border border-border/70 bg-muted/40 px-3 py-2 text-muted-foreground text-xs">
        <HugeiconsIcon
          className="size-3.5"
          icon={TextIcon}
        />
        <span className="min-w-0 truncate font-medium">
          {summary.succeeded}/{summary.total} files changed
          {summary.failed > 0 ? `, ${summary.failed} failed` : ''}
          {(summary.warnings ?? 0) > 0 ? `, ${summary.warnings} warning${summary.warnings === 1 ? '' : 's'}` : ''}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[11px]">
          <span className="text-emerald-500">+{summary.added}</span>
          <span className="mx-1 text-muted-foreground/50">/</span>
          <span className="text-red-500">-{summary.removed}</span>
        </span>
      </div>
      {visibleFiles.map((file) =>
        file.status === 'ok' && file.display ? (
          <FileDiffOutputBlock
            display={file.display}
            key={`${file.path}-${file.operation ?? 'ok'}`}
          />
        ) : (
          <div
            className="overflow-hidden rounded-md border border-destructive/30 bg-destructive/5"
            key={`${file.path}-${file.operation ?? 'error'}`}
          >
            <div className="flex items-center gap-2 border-destructive/20 border-b px-3 py-2 text-destructive text-xs">
              <HugeiconsIcon
                className="size-3.5"
                icon={TextIcon}
              />
              <span className="min-w-0 truncate font-mono">{file.path}</span>
              {file.operation && <span className="ml-auto shrink-0 font-mono text-[11px]">{file.operation}</span>}
            </div>
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap p-3 font-mono text-[12px] text-destructive leading-relaxed">
              {file.error ?? 'operation failed'}
            </pre>
          </div>
        )
      )}
      {hiddenCount > 0 && (
        <button
          className="rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-left text-muted-foreground text-xs hover:bg-muted/50"
          onClick={() => setExpanded(true)}
          type="button"
        >
          Show {hiddenCount} more file{hiddenCount === 1 ? '' : 's'}
        </button>
      )}
      {expanded && display.files.length > 4 && (
        <button
          className="rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-left text-muted-foreground text-xs hover:bg-muted/50"
          onClick={() => setExpanded(false)}
          type="button"
        >
          Show fewer files
        </button>
      )}
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
                  <HugeiconsIcon
                    className="size-2.5 shrink-0 text-muted-foreground/40"
                    icon={ExternalLinkIcon}
                  />
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
