import type { McpAppView, SessionId } from '@monad/protocol';
import type { ToolPart } from '@monad/ui';

import {
  ComputerTerminal01Icon,
  ExternalLinkIcon,
  PackageIcon,
  SquareIcon,
  TextIcon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useCancelMcpTaskMutation } from '@monad/client-rtk';
import { mcpAppCapabilityResponseSchema, mcpAppViewResponseSchema } from '@monad/protocol';
import { Button, cn, FileIcon, Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@monad/ui';
import { CodeInline } from '@monad/ui/components/CodeBlock';
import { Markdown } from '@monad/ui/components/Markdown';
import { memo, useEffect, useMemo, useRef, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { useToolBackendsSettings } from '#/hooks/use-tool-backends-settings';
import { type FileDiffPreviewDisplay, FileReadPreview, UnifiedDiffPreview } from './FileToolPreview';
import { parseMcpTaskProgress } from './mcp-task-progress';

export interface ToolItem {
  kind: 'tool';
  id: string;
  tool: string;
  input?: unknown;
  status: 'running' | 'ok' | 'error';
  output?: string;
  errorCode?: string;
  display?: unknown;
  seq?: string;
}

export interface ToolGroupItem {
  kind: 'toolGroup';
  id: string;
  steps: ToolItem[];
  seq?: string;
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

export function safeWebSearchUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : '#';
  } catch {
    return '#';
  }
}

export function safeMcpAppExternalUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function declaredMcpAppOrigins(csp: Record<string, unknown> | undefined, key: string): string[] {
  const value = csp?.[key];
  if (!Array.isArray(value)) return [];
  const origins = new Set<string>();
  for (const candidate of value.slice(0, 32)) {
    if (typeof candidate !== 'string') continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === 'https:') origins.add(url.origin);
    } catch {}
  }
  return [...origins];
}

const MCP_APP_PERMISSION_FEATURES = {
  camera: 'camera',
  microphone: 'microphone',
  geolocation: 'geolocation',
  clipboardWrite: 'clipboard-write'
} as const;

function hasMcpAppPermission(permissions: Record<string, unknown> | undefined, key: string): boolean {
  const value = permissions?.[key];
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function grantedMcpAppPermissions(permissions?: Record<string, unknown>): Record<string, Record<string, never>> {
  return Object.fromEntries(
    Object.keys(MCP_APP_PERMISSION_FEATURES)
      .filter((key) => hasMcpAppPermission(permissions, key))
      .map((key) => [key, {}])
  );
}

export function mcpAppPermissionsPolicy(permissions?: Record<string, unknown>): string {
  return Object.entries(MCP_APP_PERMISSION_FEATURES)
    .map(([key, feature]) => `${feature} ${hasMcpAppPermission(permissions, key) ? '*' : "'none'"}`)
    .join('; ');
}

export function sandboxedMcpAppHtml(
  html: string,
  csp?: Record<string, unknown>,
  permissions?: Record<string, unknown>
): string {
  const connect = declaredMcpAppOrigins(csp, 'connectDomains');
  const resources = declaredMcpAppOrigins(csp, 'resourceDomains');
  const frames = declaredMcpAppOrigins(csp, 'frameDomains');
  const policy = [
    "default-src 'none'",
    "base-uri 'none'",
    `connect-src ${connect.length ? connect.join(' ') : "'none'"}`,
    "form-action 'none'",
    `img-src data: blob:${resources.length ? ` ${resources.join(' ')}` : ''}`,
    `media-src blob:${resources.length ? ` ${resources.join(' ')}` : ''}`,
    `font-src data:${resources.length ? ` ${resources.join(' ')}` : ''}`,
    `style-src 'unsafe-inline'${resources.length ? ` ${resources.join(' ')}` : ''}`,
    `script-src 'unsafe-inline'${resources.length ? ` ${resources.join(' ')}` : ''}`,
    `frame-src ${frames.length ? frames.join(' ') : "'none'"}`
  ].join('; ');
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy.replaceAll("'", '&apos;')}">`;
  const appHtml = /^<!doctype html>/i.test(html)
    ? html.replace(/^<!doctype html>/i, (doctype) => `${doctype}${meta}`)
    : `${meta}${html}`;
  const encoded = JSON.stringify(appHtml).replaceAll('<', '\\u003c');
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src &apos;none&apos;; script-src &apos;unsafe-inline&apos;; style-src &apos;unsafe-inline&apos;; frame-src &apos;self&apos;"><style>html,body,#app{border:0;height:100%;margin:0;width:100%}#app{display:block}</style><iframe id="app" sandbox="allow-scripts" allow="${mcpAppPermissionsPolicy(permissions)}"></iframe><script>const app=document.getElementById('app');app.srcdoc=${encoded};addEventListener('message',event=>{if(event.source===parent)app.contentWindow?.postMessage(event.data,'*');else if(event.source===app.contentWindow)parent.postMessage(event.data,'*')});</script>`;
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

type DiffDisplay = FileDiffPreviewDisplay;

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

interface SkillDisplay {
  type: 'skill';
  name: string;
  description: string;
  body: string;
  version?: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string;
  context: 'inline' | 'fork';
  modelTier?: string;
  resource?: string;
}

interface McpAppDisplay {
  type: 'mcp_app';
  resourceUri: string;
  html: string;
  data?: unknown;
  csp?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  bridgeId?: string;
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

function parseMcpAppDisplay(display: unknown): McpAppDisplay | null {
  if (!display || typeof display !== 'object' || Array.isArray(display)) return null;
  const value = display as Partial<McpAppDisplay>;
  if (value.type !== 'mcp_app' || typeof value.resourceUri !== 'string' || typeof value.html !== 'string') return null;
  const csp = value.csp && typeof value.csp === 'object' && !Array.isArray(value.csp) ? value.csp : undefined;
  const permissions =
    value.permissions && typeof value.permissions === 'object' && !Array.isArray(value.permissions)
      ? value.permissions
      : undefined;
  return {
    type: 'mcp_app',
    resourceUri: value.resourceUri,
    html: value.html,
    data: value.data,
    ...(csp ? { csp } : {}),
    ...(permissions ? { permissions } : {}),
    ...(typeof value.bridgeId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.bridgeId)
      ? { bridgeId: value.bridgeId }
      : {})
  };
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

function parseSkillDisplay(step: ToolItem): SkillDisplay {
  const fallbackName = firstStringField(step.input, ['name']) ?? 'skill';
  const fallbackResource = firstStringField(step.input, ['file']);
  if (!step.display || typeof step.display !== 'object' || Array.isArray(step.display)) {
    return {
      type: 'skill',
      name: fallbackName,
      description: '',
      body: step.output ?? '',
      context: 'inline',
      ...(fallbackResource ? { resource: fallbackResource } : {})
    };
  }

  const value = step.display as Record<string, unknown>;
  if (
    value.type !== 'skill' ||
    typeof value.name !== 'string' ||
    typeof value.description !== 'string' ||
    typeof value.body !== 'string' ||
    (value.context !== 'inline' && value.context !== 'fork')
  ) {
    return {
      type: 'skill',
      name: fallbackName,
      description: '',
      body: step.output ?? '',
      context: 'inline',
      ...(fallbackResource ? { resource: fallbackResource } : {})
    };
  }

  const metadata =
    value.metadata && typeof value.metadata === 'object' && !Array.isArray(value.metadata)
      ? Object.fromEntries(
          Object.entries(value.metadata).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        )
      : undefined;
  const optionalString = (key: string) => (typeof value[key] === 'string' ? value[key] : undefined);
  return {
    type: 'skill',
    name: value.name,
    description: value.description,
    body: value.body,
    context: value.context,
    ...(optionalString('version') ? { version: optionalString('version') } : {}),
    ...(optionalString('license') ? { license: optionalString('license') } : {}),
    ...(optionalString('compatibility') ? { compatibility: optionalString('compatibility') } : {}),
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(optionalString('allowedTools') ? { allowedTools: optionalString('allowedTools') } : {}),
    ...(optionalString('modelTier') ? { modelTier: optionalString('modelTier') } : {}),
    ...(optionalString('resource') ? { resource: optionalString('resource') } : {})
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

function firstNumberField(input: unknown, keys: string[]): number | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === 'number') return record[key];
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

const TOOL_EVENT_HEADER_CLASS =
  'min-h-7 w-fit max-w-full justify-start gap-2 p-0.5 text-[0.95rem] text-muted-foreground leading-6 [&>div]:min-w-0 [&>div]:overflow-hidden [&>div>svg]:size-4 [&>div>svg]:shrink-0 [&>div>span]:min-w-0 [&>div>span]:truncate [&>div>span]:font-normal [&>div>span]:text-[0.95rem] [&>svg]:shrink-0';

function toolEventIconTone(status: ToolItem['status']): string {
  if (status === 'error') return '[&>div>svg]:text-destructive';
  if (status === 'running') return '[&>div>svg]:text-accent-blue';
  return '[&>div>svg]:text-success';
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

function skillDisplayName(name: string | undefined): string {
  const unscoped = name?.split(':').at(-1)?.trim();
  if (!unscoped) return 'Skill';
  return unscoped
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function SingleToolView({ step, sessionId }: { step: ToolItem; sessionId?: SessionId }) {
  const t = useT();
  const isSkill = step.tool === 'skill';
  const title = isSkill
    ? t('web.tools.useSkill', { name: skillDisplayName(firstStringField(step.input, ['name'])) })
    : step.input !== undefined
      ? `${step.tool} · ${summarizeArgs(step.input)}`
      : step.tool;
  const statusLabel =
    step.status === 'running' ? t('web.tools.running') : step.status === 'error' ? t('web.tools.error') : '';

  return (
    <Tool
      className="mb-0 w-full self-start rounded-none border-0 text-base text-muted-foreground"
      defaultOpen={step.status !== 'ok'}
      {...(isSkill ? { 'data-slot': 'skill-tool-event' } : {})}
    >
      <ToolHeader
        aria-label={isSkill && statusLabel ? `${title} · ${statusLabel}` : title}
        className={cn(
          TOOL_EVENT_HEADER_CLASS,
          toolEventIconTone(step.status),
          step.status === 'running' && '[&>div>svg]:motion-safe:animate-pulse'
        )}
        icon={isSkill ? PackageIcon : undefined}
        showStatus={false}
        state={toolState(step.status)}
        title={title}
        type={`tool-${step.tool}` as `tool-${string}`}
      />
      <ToolContent className="gap-3 p-1 pt-2">
        {isSkill ? (
          <SkillDetails
            pendingLabel={t('web.tools.running')}
            step={step}
          />
        ) : (
          <ToolDetails
            pendingLabel={t('web.tools.running')}
            sessionId={sessionId}
            step={step}
          />
        )}
      </ToolContent>
    </Tool>
  );
}

function SkillDetails({ step, pendingLabel }: { step: ToolItem; pendingLabel: string }) {
  const t = useT();
  const skill = parseSkillDisplay(step);
  const nameParts = skill.name.split(':');
  const scope = nameParts.length > 1 ? nameParts.slice(0, -1).join(':') : undefined;
  const metadata = [
    skill.version ? [t('web.tools.skillVersion'), skill.version] : undefined,
    scope ? [t('web.tools.skillScope'), scope] : undefined,
    [t('web.tools.skillContext'), skill.context === 'fork' ? t('web.tools.skillFork') : t('web.tools.skillInline')],
    skill.modelTier ? [t('web.tools.skillTier'), skill.modelTier] : undefined,
    skill.license ? [t('web.tools.skillLicense'), skill.license] : undefined,
    skill.compatibility ? [t('web.tools.skillCompatibility'), skill.compatibility] : undefined,
    skill.allowedTools ? [t('web.tools.skillTools'), skill.allowedTools] : undefined,
    skill.resource ? [t('web.tools.skillResource'), skill.resource] : undefined,
    ...Object.entries(skill.metadata ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [skillDisplayName(key), value])
  ].filter((entry): entry is [string, string] => entry !== undefined);

  return (
    <div className="flex max-w-full flex-col gap-4 pb-2">
      {(skill.description || metadata.length > 0) && (
        <div
          className="flex flex-col gap-3"
          data-slot="skill-metadata"
        >
          {skill.description && (
            <p className="max-w-[72ch] text-muted-foreground text-sm leading-6">{skill.description}</p>
          )}
          {metadata.length > 0 && (
            <dl className="flex max-w-[72ch] flex-wrap gap-x-5 gap-y-1.5 text-xs leading-5">
              {metadata.map(([label, value]) => (
                <div
                  className="inline-flex min-w-0 max-w-full gap-1.5"
                  key={`${label}-${value}`}
                >
                  <dt className="shrink-0 text-muted-foreground">{label}</dt>
                  <dd className="min-w-0 break-words font-medium text-foreground/85">{value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
      {step.status === 'error' ? (
        <ToolOutput
          errorText={formatToolError(step.output, step.errorCode)}
          output={undefined}
        />
      ) : skill.body ? (
        <div
          className="max-w-[72ch] text-base text-foreground leading-6"
          data-slot="skill-body"
        >
          <Markdown
            text={skill.body}
            variant="default"
          />
        </div>
      ) : (
        step.status === 'running' && <ToolPending label={pendingLabel} />
      )}
    </div>
  );
}

function ToolGroupView({ step, sessionId }: { step: ToolGroupItem; sessionId?: SessionId }) {
  const t = useT();
  const status = groupStatus(step.steps);

  return (
    <Tool
      className="mb-0 w-full self-start rounded-none border-0 text-base text-muted-foreground"
      defaultOpen={status !== 'ok'}
    >
      <ToolHeader
        className={cn(TOOL_EVENT_HEADER_CLASS, toolEventIconTone(status))}
        showStatus={false}
        state={toolState(status)}
        title={t('web.tools.concurrentCalls', { count: step.steps.length })}
        type="tool-parallel"
      />
      <ToolContent className="gap-2 p-0 pt-1">
        <div className="flex flex-col gap-1">
          {step.steps.map((child) => (
            <ToolStepView
              key={child.id}
              sessionId={sessionId}
              step={child}
            />
          ))}
        </div>
      </ToolContent>
    </Tool>
  );
}

function ToolDetails({
  step,
  pendingLabel,
  sessionId
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
  const mcpTaskProgress = useMemo(() => parseMcpTaskProgress(step.output), [step.output]);

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
  const mcpAppDisplay = parseMcpAppDisplay(step.display);

  if (mcpTaskProgress && !isError) {
    return (
      <>
        {step.input !== undefined && <ToolInput input={step.input} />}
        <McpTaskProgressCard progress={mcpTaskProgress} />
      </>
    );
  }

  if (mcpAppDisplay && !isError) {
    return (
      <>
        {step.input !== undefined && <ToolInput input={step.input} />}
        <McpAppFrame
          display={mcpAppDisplay}
          input={step.input}
          output={step.output}
          sessionId={sessionId}
        />
        {step.output && (
          <ToolOutput
            errorText={undefined}
            output={parsedJsonObject(step.output) ?? step.output}
          />
        )}
      </>
    );
  }

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
        <UnifiedDiffPreview display={diffDisplay} />
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
        <FileReadPreview
          offset={firstNumberField(step.input, ['offset'])}
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

function McpTaskProgressCard({ progress }: { progress: NonNullable<ReturnType<typeof parseMcpTaskProgress>> }) {
  const t = useT();
  const [cancelTask, { isLoading }] = useCancelMcpTaskMutation();
  return (
    <div
      className="flex max-w-[72ch] flex-col gap-2 rounded-md border border-border bg-muted/25 p-3"
      data-slot="mcp-task-progress"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="size-2 shrink-0 rounded-full bg-accent-blue motion-safe:animate-pulse" />
        <span className="truncate font-medium text-foreground text-sm">
          {progress.server} · {progress.tool}
        </span>
        <span className="ml-auto shrink-0 text-muted-foreground text-xs">
          {progress.status === 'input_required' ? t('web.tools.taskInputRequired') : t('web.tools.taskWorking')}
        </span>
      </div>
      {progress.statusMessage && <p className="text-muted-foreground text-sm leading-5">{progress.statusMessage}</p>}
      <div className="flex flex-wrap items-end justify-between gap-2">
        <dl className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground">
          <div className="flex min-w-0 gap-1.5">
            <dt>{t('web.tools.taskId')}</dt>
            <dd className="truncate">{progress.taskId}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt>{t('web.tools.taskUpdated')}</dt>
            <dd>{new Date(progress.lastUpdatedAt).toLocaleTimeString()}</dd>
          </div>
        </dl>
        <Button
          disabled={isLoading}
          onClick={() => void cancelTask({ name: progress.server, taskId: progress.taskId })}
          size="sm"
          variant="outline"
        >
          <HugeiconsIcon
            className="size-3.5"
            icon={SquareIcon}
          />
          {isLoading ? t('web.tools.taskCancelling') : t('web.tools.taskCancel')}
        </Button>
      </div>
    </div>
  );
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

function waitForDocumentVisibility(signal: AbortSignal): Promise<void> {
  if (signal.aborted || document.visibilityState !== 'hidden') return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      if (document.visibilityState === 'hidden' && !signal.aborted) return;
      document.removeEventListener('visibilitychange', finish);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    document.addEventListener('visibilitychange', finish);
    signal.addEventListener('abort', finish, { once: true });
  });
}

function McpAppFrame({
  display,
  input,
  output,
  sessionId
}: {
  display: McpAppDisplay;
  input: unknown;
  output?: string;
  sessionId?: SessionId;
}) {
  const t = useT();
  const frame = useRef<HTMLIFrameElement>(null);
  const [liveView, setLiveView] = useState<McpAppView>();
  const activeDisplay = liveView ? { ...display, ...liveView } : display;
  const [height, setHeight] = useState(320);
  const heightRef = useRef(height);
  const [pendingLink, setPendingLink] = useState<{ id: string | number; url: string }>();
  const [viewHealth, setViewHealth] = useState<'live' | 'stale'>('live');
  const [viewRetry, setViewRetry] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: viewRetry is an explicit watcher restart trigger.
  useEffect(() => {
    if (!display.bridgeId || !sessionId) return;
    const abort = new AbortController();
    let revision: string | undefined;
    const watch = async () => {
      let delayMs = 1_000;
      while (!abort.signal.aborted) {
        if (document.visibilityState === 'hidden') await waitForDocumentVisibility(abort.signal);
        try {
          const response = await fetch('/v1/mcp-apps/views', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ bridgeId: display.bridgeId, sessionId, afterRevision: revision }),
            signal: abort.signal
          });
          const raw = await response.json();
          if (!response.ok) throw new Error('MCP App view is unavailable');
          const payload = mcpAppViewResponseSchema.parse(raw);
          if (payload.changed && payload.view) {
            revision = payload.view.revision;
            setLiveView(payload.view);
          }
          delayMs = 1_000;
          setViewHealth('live');
        } catch {
          if (abort.signal.aborted) return;
          setViewHealth('stale');
          await abortableDelay(delayMs + Math.floor(Math.random() * 250), abort.signal);
          delayMs = Math.min(delayMs * 2, 30_000);
        }
      }
    };
    void watch();
    return () => abort.abort();
  }, [display.bridgeId, sessionId, viewRetry]);

  useEffect(() => {
    const abort = new AbortController();
    let capabilityError: string | undefined;
    let capabilityToken: string | undefined;
    let disposed = false;
    const capabilityReady =
      activeDisplay.bridgeId && sessionId
        ? fetch('/v1/mcp-apps/capabilities', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              bridgeId: activeDisplay.bridgeId,
              sessionId,
              ...(liveView?.revision ? { revision: liveView.revision } : {})
            }),
            signal: abort.signal
          })
            .then(async (response) => {
              const raw = (await response.json()) as { error?: string };
              if (!response.ok) throw new Error(raw.error ?? t('web.tools.mcpAppMethodUnavailable'));
              const payload = mcpAppCapabilityResponseSchema.parse(raw);
              if (disposed) {
                void fetch(`/v1/mcp-apps/${payload.token}/capability`, { method: 'DELETE', keepalive: true });
              } else {
                capabilityToken = payload.token;
              }
            })
            .catch((error) => {
              if (!abort.signal.aborted) {
                capabilityError = error instanceof Error ? error.message : t('web.tools.mcpAppMethodUnavailable');
              }
            })
        : Promise.resolve();
    const send = (message: Record<string, unknown>) => frame.current?.contentWindow?.postMessage(message, '*');
    const reply = (id: string | number, result: unknown) => send({ jsonrpc: '2.0', id, result });
    const reject = (id: string | number, code: number, message: string) =>
      send({ jsonrpc: '2.0', id, error: { code, message } });
    const deliverToolData = () => {
      send({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: input ?? {} } });
      send({
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-result',
        params: {
          content: output ? [{ type: 'text', text: output }] : [],
          ...(activeDisplay.data !== undefined ? { structuredContent: activeDisplay.data } : {})
        }
      });
    };
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== frame.current?.contentWindow || !event.data || typeof event.data !== 'object') return;
      const message = event.data as Record<string, unknown>;
      const method = typeof message.method === 'string' ? message.method : undefined;
      const id = typeof message.id === 'string' || typeof message.id === 'number' ? message.id : undefined;
      if (method === 'ui/initialize' && id !== undefined) {
        const permissions = grantedMcpAppPermissions(activeDisplay.permissions);
        reply(id, {
          protocolVersion: '2026-01-26',
          hostInfo: { name: 'monad', version: '0.0.0' },
          hostCapabilities: {
            openLinks: {},
            serverTools: {},
            serverResources: {},
            sandbox: {
              permissions,
              ...(activeDisplay.csp ? { csp: activeDisplay.csp } : {})
            }
          },
          hostContext: {
            theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
            locale: navigator.language,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            displayMode: 'inline',
            containerDimensions: { height: heightRef.current }
          }
        });
        return;
      }
      if (method === 'ping' && id !== undefined) {
        reply(id, {});
        return;
      }
      if (method === 'ui/notifications/initialized') {
        deliverToolData();
        return;
      }
      if (method === 'ui/notifications/size-changed') {
        const requested = (message.params as { height?: unknown } | undefined)?.height;
        if (typeof requested === 'number' && Number.isFinite(requested)) {
          const next = Math.min(Math.max(requested, 160), 900);
          heightRef.current = next;
          setHeight(next);
        }
        return;
      }
      if (method === 'ui/open-link' && id !== undefined) {
        const url = (message.params as { url?: unknown } | undefined)?.url;
        const externalUrl = typeof url === 'string' ? safeMcpAppExternalUrl(url) : undefined;
        if (!externalUrl) {
          reject(id, -32602, t('web.tools.mcpAppInvalidLink'));
          return;
        }
        setPendingLink({ id, url: externalUrl });
        return;
      }
      if (
        (method === 'tools/call' || method === 'resources/read') &&
        id !== undefined &&
        activeDisplay.bridgeId &&
        sessionId
      ) {
        void capabilityReady
          .then(() => {
            if (!capabilityToken) throw new Error(capabilityError ?? t('web.tools.mcpAppMethodUnavailable'));
            return fetch(`/v1/mcp-apps/${capabilityToken}/rpc`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ method, params: message.params ?? {} }),
              signal: abort.signal
            });
          })
          .then(async (response) => {
            const payload = (await response.json()) as { result?: unknown; error?: string };
            if (response.ok) reply(id, payload.result);
            else reject(id, -32000, payload.error ?? t('web.tools.mcpAppMethodUnavailable'));
          })
          .catch((error) => {
            if (!abort.signal.aborted) {
              reject(id, -32000, error instanceof Error ? error.message : t('web.tools.mcpAppMethodUnavailable'));
            }
          });
        return;
      }
      if (id !== undefined) reject(id, -32601, t('web.tools.mcpAppMethodUnavailable'));
    };
    window.addEventListener('message', onMessage);
    return () => {
      disposed = true;
      abort.abort();
      send({ jsonrpc: '2.0', id: 'monad-ui-teardown', method: 'ui/resource-teardown', params: { reason: 'unmount' } });
      window.removeEventListener('message', onMessage);
      if (capabilityToken) {
        void fetch(`/v1/mcp-apps/${capabilityToken}/capability`, { method: 'DELETE', keepalive: true });
      }
    };
  }, [
    activeDisplay.bridgeId,
    activeDisplay.csp,
    activeDisplay.data,
    activeDisplay.permissions,
    input,
    liveView?.revision,
    output,
    sessionId,
    t
  ]);

  const respondToLink = (allow: boolean) => {
    if (!pendingLink) return;
    if (allow) window.open(pendingLink.url, '_blank', 'noopener,noreferrer');
    frame.current?.contentWindow?.postMessage(
      allow
        ? { jsonrpc: '2.0', id: pendingLink.id, result: {} }
        : {
            jsonrpc: '2.0',
            id: pendingLink.id,
            error: { code: -32000, message: t('web.tools.mcpAppLinkDeclined') }
          },
      '*'
    );
    setPendingLink(undefined);
  };

  return (
    <div className="flex w-full flex-col gap-2">
      <iframe
        allow={mcpAppPermissionsPolicy(activeDisplay.permissions)}
        className="w-full rounded-md border border-border bg-background"
        key={liveView?.revision ?? display.html}
        ref={frame}
        sandbox="allow-scripts"
        srcDoc={sandboxedMcpAppHtml(activeDisplay.html, activeDisplay.csp, activeDisplay.permissions)}
        style={{ height }}
        title={activeDisplay.resourceUri}
      />
      {viewHealth === 'stale' && (
        <div className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs">
          <span className="min-w-0 flex-1">{t('web.tools.mcpAppStale')}</span>
          <Button
            onClick={() => setViewRetry((value) => value + 1)}
            size="sm"
            variant="outline"
          >
            {t('web.tools.mcpAppRetry')}
          </Button>
        </div>
      )}
      {pendingLink && (
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 p-2 text-xs">
          <span className="min-w-0 flex-1 truncate">{t('web.tools.mcpAppOpenLink', { url: pendingLink.url })}</span>
          <Button
            onClick={() => respondToLink(false)}
            size="sm"
            variant="ghost"
          >
            {t('web.tools.mcpAppDecline')}
          </Button>
          <Button
            onClick={() => respondToLink(true)}
            size="sm"
            variant="outline"
          >
            {t('web.tools.mcpAppOpen')}
          </Button>
        </div>
      )}
    </div>
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

function MultiFileDiffOutputBlock({ display }: { display: MultiDiffDisplay }) {
  const t = useT();
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
          {t('web.workplace.fileChange.changedSummary', { count: summary.total, succeeded: summary.succeeded })}
          {summary.failed > 0 ? `, ${summary.failed} failed` : ''}
          {(summary.warnings ?? 0) > 0
            ? `, ${t('web.workplace.fileChange.warnings', { count: summary.warnings ?? 0 })}`
            : ''}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[11px]">
          <span className="text-emerald-500">+{summary.added}</span>
          <span className="mx-1 text-muted-foreground/50">/</span>
          <span className="text-red-500">-{summary.removed}</span>
        </span>
      </div>
      {visibleFiles.map((file) =>
        file.status === 'ok' && file.display ? (
          <UnifiedDiffPreview
            display={file.display}
            key={`${file.path}-${file.operation ?? 'ok'}`}
          />
        ) : (
          <div
            className="overflow-hidden rounded-md border border-destructive/30 bg-destructive/5"
            key={`${file.path}-${file.operation ?? 'error'}`}
          >
            <div className="flex items-center gap-2 border-destructive/20 border-b px-3 py-2 text-destructive text-xs">
              <FileIcon
                className="size-3.5"
                fileName={file.path}
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
          {t('web.workplace.fileChange.showMore', { count: hiddenCount })}
        </button>
      )}
      {expanded && display.files.length > 4 && (
        <button
          className="rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-left text-muted-foreground text-xs hover:bg-muted/50"
          onClick={() => setExpanded(false)}
          type="button"
        >
          {t('web.workplace.fileChange.showFewer')}
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
                  href={safeWebSearchUrl(r.url)}
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
