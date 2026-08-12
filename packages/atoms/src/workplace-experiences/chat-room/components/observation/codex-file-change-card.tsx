import type { AgentObservationEvent } from '@monad/protocol';

import { FileCodeIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { CompactFilePath, FileIcon, UnifiedDiff } from '@monad/ui';

import { workplaceExperienceT } from '../../../i18n.ts';
import { type ObservationToolStatus, ObservationToolStatusIndicator } from './card-shell.tsx';
import { useObservationDisclosure } from './disclosure.tsx';
import { observationContractRawEvents } from './provenance.ts';

const INITIAL_FILE_COUNT = 3;

type CodexFileChange = {
  additions: number;
  deletions: number;
  diff?: string;
  kind: string;
  movePath?: string;
  path: string;
  /** The diff was reconstructed from tool arguments that never said where the edit landed, so its
   *  hunk positions are placeholders and must not be rendered as file line numbers. */
  positionUnknown?: boolean;
};

export type CodexFileChangeView = {
  additions: number;
  deletions: number;
  files: CodexFileChange[];
  status?: string;
};

export function codexFileChangeView(contractEvents: readonly unknown[]): CodexFileChangeView | null {
  const rawEvents = observationContractRawEvents(contractEvents);
  const fileChangeItem = rawEvents.map(fileChangeItemFromRaw).find((candidate) => candidate !== undefined);
  if (!fileChangeItem) return null;
  const files = Array.isArray(fileChangeItem.changes)
    ? fileChangeItem.changes.flatMap((change) => {
        const record = recordValue(change);
        const path = stringValue(record?.path);
        if (!record || !path) return [];
        const kindRecord = recordValue(record.kind);
        const diff = stringValue(record.diff);
        const stats = diffStats(diff);
        return [
          {
            additions: stats.additions,
            deletions: stats.deletions,
            ...(diff ? { diff } : {}),
            kind: stringValue(kindRecord?.type, record.kind) ?? 'update',
            ...(stringValue(kindRecord?.move_path, kindRecord?.movePath)
              ? { movePath: stringValue(kindRecord?.move_path, kindRecord?.movePath) }
              : {}),
            path
          }
        ];
      })
    : [];
  if (files.length === 0) return null;
  return {
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    files,
    ...(stringValue(fileChangeItem.status) ? { status: stringValue(fileChangeItem.status) } : {})
  };
}

export function claudeFileChangeView(
  call: AgentObservationEvent | undefined,
  result: AgentObservationEvent | undefined
): CodexFileChangeView | null {
  if (!call) return null;
  const toolName = call.tool?.name;
  if (toolName !== 'Write' && toolName !== 'Edit' && toolName !== 'MultiEdit') return null;
  const input = recordValue(call.tool?.input);
  const path = stringValue(input?.file_path, input?.filePath);
  if (!input || !path) return null;
  const diff = claudeFileToolDiff(toolName, input);
  const stats = diffStats(diff);
  return {
    additions: stats.additions,
    deletions: stats.deletions,
    files: [
      {
        additions: stats.additions,
        deletions: stats.deletions,
        ...(diff ? { diff } : {}),
        kind: toolName === 'Write' ? 'write' : 'update',
        path,
        ...(toolName === 'Write' ? {} : { positionUnknown: true })
      }
    ],
    status: result?.tool?.status ?? call.tool?.status ?? (result ? 'completed' : 'running')
  };
}

export function CodexFileChangeCard({
  timestamp,
  view
}: {
  timestamp?: string;
  view: CodexFileChangeView;
}): React.ReactElement {
  const t = workplaceExperienceT();
  const [showAll, setShowAll] = useObservationDisclosure('file-change/all');
  const visibleFiles = showAll ? view.files : view.files.slice(0, INITIAL_FILE_COUNT);
  const hiddenCount = view.files.length - visibleFiles.length;
  const status = fileChangeStatus(view.status);
  return (
    <article
      className="w-full min-w-0 max-w-full overflow-hidden rounded-xl border border-border bg-card"
      data-codex-file-change-card="true"
    >
      <header className="flex min-w-0 items-center gap-3 border-border border-b px-4 py-3">
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
          <HugeiconsIcon
            aria-hidden="true"
            icon={FileCodeIcon}
            size={18}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 font-semibold text-foreground text-sm">
            <span>{t('web.workplace.fileChange.editedFiles', { count: view.files.length })}</span>
            <ObservationToolStatusIndicator status={status} />
          </div>
          <FileChangeStats
            additions={view.additions}
            deletions={view.deletions}
          />
        </div>
        {timestamp ? <time className="shrink-0 font-ui text-[10px] text-muted-foreground">{timestamp}</time> : null}
      </header>
      <div className="divide-y divide-border/70">
        {visibleFiles.map((file) => (
          <CodexFileChangeRow
            file={file}
            key={`${file.path}:${file.movePath ?? ''}`}
          />
        ))}
      </div>
      {hiddenCount > 0 ? (
        <button
          className="w-full border-border border-t px-4 py-2.5 text-left text-muted-foreground text-sm hover:bg-secondary/55 hover:text-foreground"
          onClick={() => setShowAll(true)}
          type="button"
        >
          {t('web.workplace.fileChange.showMore', { count: hiddenCount })}
        </button>
      ) : showAll && view.files.length > INITIAL_FILE_COUNT ? (
        <button
          className="w-full border-border border-t px-4 py-2.5 text-left text-muted-foreground text-sm hover:bg-secondary/55 hover:text-foreground"
          onClick={() => setShowAll(false)}
          type="button"
        >
          {t('web.workplace.fileChange.showFewer')}
        </button>
      ) : null}
    </article>
  );
}

function fileChangeStatus(status: string | undefined): ObservationToolStatus {
  const normalized = status?.trim().toLowerCase();
  if (normalized === 'error' || normalized === 'failed') return 'error';
  if (normalized === 'running' || normalized === 'pending' || normalized === 'in_progress') return 'running';
  return 'success';
}

function CodexFileChangePath({ file }: { file: CodexFileChange }): React.ReactElement {
  if (!file.movePath) {
    return (
      <CompactFilePath
        className="flex-1 font-ui text-foreground text-xs"
        data-file-change-path="path"
        path={file.path}
      />
    );
  }

  return (
    <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1">
      <CompactFilePath
        className="font-ui text-foreground text-xs"
        data-file-change-path="from"
        path={file.path}
      />
      <span className="shrink-0 font-ui text-muted-foreground text-xs">→</span>
      <CompactFilePath
        className="font-ui text-foreground text-xs"
        data-file-change-path="to"
        path={file.movePath}
      />
    </span>
  );
}

function CodexFileChangeRow({ file }: { file: CodexFileChange }): React.ReactElement {
  const [diffOpen, setDiffOpen] = useObservationDisclosure(`file-change/diff/${file.path}`);
  const summary = (
    <>
      <FileIcon
        className="size-4 shrink-0"
        fileName={file.movePath ?? file.path}
      />
      <CodexFileChangePath file={file} />
      <FileChangeStats
        additions={file.additions}
        deletions={file.deletions}
      />
    </>
  );
  return (
    <section>
      {file.diff ? (
        <button
          aria-expanded={diffOpen}
          className="flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left hover:bg-secondary/45"
          onClick={() => setDiffOpen(!diffOpen)}
          type="button"
        >
          {summary}
        </button>
      ) : (
        <div className="flex min-w-0 items-center gap-3 px-4 py-3">{summary}</div>
      )}
      {diffOpen && file.diff ? (
        <UnifiedDiff
          added={file.additions}
          className="rounded-none border-x-0 border-b-0"
          diff={file.diff}
          path={file.movePath ?? file.path}
          removed={file.deletions}
          showHeader={false}
          showLineNumbers={!file.positionUnknown}
        />
      ) : null}
    </section>
  );
}

function FileChangeStats({ additions, deletions }: { additions: number; deletions: number }): React.ReactElement {
  return (
    <span className="inline-flex shrink-0 gap-1.5 font-ui text-xs">
      <span className="text-success">+{additions}</span>
      <span className="text-destructive">-{deletions}</span>
    </span>
  );
}

function fileChangeItemFromRaw(value: unknown): Record<string, unknown> | undefined {
  const record = recordValue(value);
  if (!record) return undefined;
  const params = recordValue(record.params);
  const data = recordValue(record.data);
  const candidates = [
    record,
    recordValue(record.item),
    params,
    recordValue(params?.item),
    data,
    recordValue(data?.item)
  ];
  return candidates.find((candidate) => stringValue(candidate?.type) === 'fileChange');
}

function claudeFileToolDiff(
  toolName: 'Write' | 'Edit' | 'MultiEdit',
  input: Record<string, unknown>
): string | undefined {
  if (toolName === 'Write') return replacementDiff('', rawStringValue(input.content) ?? '');
  if (toolName === 'Edit') {
    return replacementDiff(
      rawStringValue(input.old_string, input.oldString) ?? '',
      rawStringValue(input.new_string, input.newString) ?? ''
    );
  }
  if (!Array.isArray(input.edits)) return undefined;
  const hunks = input.edits.flatMap((edit) => {
    const record = recordValue(edit);
    if (!record) return [];
    const oldText = rawStringValue(record.old_string, record.oldString) ?? '';
    const newText = rawStringValue(record.new_string, record.newString) ?? '';
    const diff = replacementDiff(oldText, newText);
    return diff ? [diff] : [];
  });
  return hunks.length > 0 ? hunks.join('\n') : undefined;
}

function replacementDiff(oldText: string, newText: string): string | undefined {
  const oldLines = diffTextLines(oldText);
  const newLines = diffTextLines(newText);
  if (oldLines.length === 0 && newLines.length === 0) return undefined;
  return [
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`)
  ].join('\n');
}

function diffTextLines(text: string): string[] {
  if (!text) return [];
  return text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
}

function diffStats(diff: string | undefined): { additions: number; deletions: number } {
  if (!diff) return { additions: 0, deletions: 0 };
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function rawStringValue(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string');
}
