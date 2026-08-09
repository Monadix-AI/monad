import type { BundledLanguage } from 'shiki';

import { CodeBlock } from './CodeBlock';
import { ObservationMeta } from './ObservationCard';

export interface CommandCardView {
  command?: string;
  commandLanguage?: string;
  cwd?: string;
  durationMs?: number;
  exitCode?: number;
  output?: string;
  outputLanguage?: string;
  provider: string;
  status?: string;
  type: string;
}

export function CommandCard({ quiet = false, view }: { quiet?: boolean; view: CommandCardView }) {
  return (
    <div
      className={
        quiet
          ? 'max-w-full overflow-hidden rounded-md border border-border/60 bg-secondary/20'
          : 'max-w-full overflow-hidden rounded-lg border border-warning/40 bg-warning/6'
      }
    >
      {view.command ? (
        <CommandCodeSection
          code={view.command}
          label="input"
          language={bundledLanguage(view.commandLanguage, 'bash')}
          quiet={quiet}
        />
      ) : null}
      {view.output ? (
        <CommandCodeSection
          code={view.output}
          label="output"
          language={bundledLanguage(view.outputLanguage, commandOutputLanguage(view.output))}
          quiet={quiet}
        />
      ) : null}
    </div>
  );
}

export function CommandCardHeader({ quiet = false, view }: { quiet?: boolean; view: CommandCardView }) {
  const failed =
    view.exitCode !== undefined ? view.exitCode !== 0 : view.status === 'failed' || view.status === 'error';
  if (quiet) {
    return (
      <ObservationMeta
        compact
        label="tool call"
        quiet
        showSource={false}
        source={view.provider}
        title={view.type}
      >
        {view.command && showsCommandSummary(view.type) ? (
          <span className="min-w-0 truncate text-muted-foreground">{singleLine(view.command)}</span>
        ) : null}
        <span className="sr-only">{commandStatusLabel(view)}</span>
        {view.durationMs !== undefined ? (
          <span className="shrink-0 text-muted-foreground">{formatDurationMs(view.durationMs)}</span>
        ) : null}
      </ObservationMeta>
    );
  }
  return (
    <ObservationMeta
      compact
      label="tool call"
      showSource={false}
      source={view.provider}
      title={view.type}
    >
      <span
        className={
          failed
            ? 'rounded-full border border-destructive/50 bg-destructive/10 px-2 py-0.5 text-destructive'
            : 'rounded-full border border-success/45 bg-success/10 px-2 py-0.5 text-success'
        }
      >
        {commandStatusLabel(view)}
      </span>
      {view.durationMs !== undefined ? <CommandMetaChip>{formatDurationMs(view.durationMs)}</CommandMetaChip> : null}
      {view.cwd ? <CommandMetaChip>{view.cwd}</CommandMetaChip> : null}
    </ObservationMeta>
  );
}

function CommandMetaChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="min-w-0 max-w-full truncate rounded-full border border-border/80 bg-background/75 px-2 py-0.5 text-muted-foreground">
      {children}
    </span>
  );
}

function CommandCodeSection({
  code,
  label,
  language,
  quiet
}: {
  code: string;
  label: string;
  language: BundledLanguage;
  quiet: boolean;
}) {
  return (
    <section
      className={
        quiet
          ? label === 'input'
            ? 'flex min-w-0 flex-col gap-1.5 p-2.5'
            : 'flex min-w-0 flex-col gap-1.5 border-border/60 border-t p-2.5'
          : label === 'input'
            ? 'flex min-w-0 flex-col gap-1.5 bg-foreground/5 p-2.5'
            : 'flex min-w-0 flex-col gap-1.5 border-border/70 border-t bg-warning/5 p-2.5'
      }
    >
      <div className="font-bold font-mono text-[10px] text-foreground uppercase">{label}</div>
      <CodeBlock
        className="[&>div]:scrollbar-none rounded-md border-0 bg-transparent text-[11px] [&>div::-webkit-scrollbar]:hidden [&>div]:max-h-72 [&>div]:overflow-auto [&_pre]:p-0"
        code={code}
        language={language}
      />
    </section>
  );
}

function commandStatusLabel(view: CommandCardView): string {
  if (view.exitCode !== undefined) return view.exitCode === 0 ? 'completed' : `exit ${view.exitCode}`;
  return view.status ?? 'running';
}

function formatDurationMs(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function showsCommandSummary(type: string): boolean {
  return ['bash', 'command_execution', 'shell', 'shell_exec'].includes(type.toLowerCase());
}

function commandOutputLanguage(text: string): BundledLanguage {
  const trimmed = text.trim();
  if (!trimmed) return 'bash';
  try {
    JSON.parse(trimmed);
    return 'json';
  } catch {
    return 'bash';
  }
}

function bundledLanguage(value: string | undefined, fallback: BundledLanguage): BundledLanguage {
  switch (value) {
    case 'bash':
    case 'css':
    case 'go':
    case 'html':
    case 'java':
    case 'javascript':
    case 'json':
    case 'markdown':
    case 'python':
    case 'ruby':
    case 'rust':
    case 'sql':
    case 'typescript':
    case 'yaml':
      return value;
    default:
      return fallback;
  }
}
