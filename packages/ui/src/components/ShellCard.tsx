import { CodeBlock, CodeBlockCopyButtonOverlay } from './CodeBlock';
import { ObservationMeta } from './ObservationCard';

export interface ShellCardView {
  command: string;
  cwd?: string;
  durationMs?: number;
  exitCode?: number;
  output?: string;
  provider: string;
  status?: string;
  title?: string;
  type: string;
}

export interface ShellCardHeaderLabels {
  completed: string;
  exitCode: (code: number) => string;
  running: string;
  toolCall: string;
}

export function ShellCard({
  copyCommandLabel,
  copyOutputLabel,
  view
}: {
  copyCommandLabel: string;
  copyOutputLabel: string;
  view: ShellCardView;
}) {
  return (
    <div
      className="max-w-full overflow-hidden rounded-md border border-border/60 bg-secondary/20"
      data-slot="shell-tool-card"
    >
      <div
        className="group/shell-command relative flex min-w-0 items-start gap-2 p-2.5"
        data-shell-copy-target="command"
      >
        <span
          aria-hidden="true"
          className="shrink-0 select-none font-mono text-muted-foreground"
        >
          $
        </span>
        <CodeBlock
          className="min-w-0 flex-1 rounded-none border-0 bg-transparent text-[11px] [&_[data-slot=code-block-content]>div]:overflow-auto [&_pre]:p-0"
          code={view.command}
          language="bash"
        />
        <CodeBlockCopyButtonOverlay
          aria-label={copyCommandLabel}
          className="opacity-0 transition-opacity group-focus-within/shell-command:opacity-100 group-hover/shell-command:opacity-100"
          data-copy-target="command"
          value={view.command}
        />
      </div>
      {view.output ? (
        <div
          className="group/shell-output relative border-border/60 border-t p-2.5"
          data-shell-copy-target="output"
        >
          <CodeBlockCopyButtonOverlay
            aria-label={copyOutputLabel}
            className="opacity-0 transition-opacity group-focus-within/shell-output:opacity-100 group-hover/shell-output:opacity-100"
            data-copy-target="content"
            value={view.output}
          />
          <pre
            className="m-0 max-h-72 overflow-auto whitespace-pre font-mono text-[11px] text-foreground"
            data-selectable="true"
          >
            {view.output}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

export function ShellCardHeader({ labels, view }: { labels: ShellCardHeaderLabels; view: ShellCardView }) {
  return (
    <ObservationMeta
      compact
      label={labels.toolCall}
      quiet
      showSource={false}
      source={view.provider}
      title={view.title ?? view.type}
    >
      {view.title ? null : <span className="min-w-0 truncate text-muted-foreground">{singleLine(view.command)}</span>}
      <span className="sr-only">{shellStatusLabel(view, labels)}</span>
      {view.durationMs === undefined ? null : (
        <span className="shrink-0 text-muted-foreground">{formatDurationMs(view.durationMs)}</span>
      )}
    </ObservationMeta>
  );
}

function shellStatusLabel(view: ShellCardView, labels: ShellCardHeaderLabels): string {
  if (view.exitCode !== undefined) return view.exitCode === 0 ? labels.completed : labels.exitCode(view.exitCode);
  return view.status ?? labels.running;
}

function formatDurationMs(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
