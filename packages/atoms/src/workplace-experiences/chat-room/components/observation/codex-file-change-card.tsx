import { FileCodeIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { FileIcon, UnifiedDiff } from '@monad/ui';
import { useState } from 'react';

import { workplaceExperienceT } from '../../../i18n.ts';
import { type ObservationToolStatus, ObservationToolStatusIndicator } from './card-shell.tsx';
import { observationContractRawEvents } from './provenance.ts';

const INITIAL_FILE_COUNT = 3;

type CodexFileChange = {
  additions: number;
  deletions: number;
  diff?: string;
  kind: string;
  movePath?: string;
  path: string;
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

export function CodexFileChangeCard({
  timestamp,
  view
}: {
  timestamp?: string;
  view: CodexFileChangeView;
}): React.ReactElement {
  const t = workplaceExperienceT();
  const [showAll, setShowAll] = useState(false);
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
        {timestamp ? <time className="shrink-0 font-mono text-[10px] text-muted-foreground">{timestamp}</time> : null}
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

function CodexFileChangeRow({ file }: { file: CodexFileChange }): React.ReactElement {
  const [diffOpen, setDiffOpen] = useState(false);
  const path = file.movePath ? `${file.path} → ${file.movePath}` : file.path;
  const summary = (
    <>
      <FileIcon
        className="size-4 shrink-0"
        fileName={file.movePath ?? file.path}
      />
      <span className="min-w-0 flex-1 truncate font-mono text-foreground text-xs">{path}</span>
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
          onClick={() => setDiffOpen((open) => !open)}
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
        />
      ) : null}
    </section>
  );
}

function FileChangeStats({ additions, deletions }: { additions: number; deletions: number }): React.ReactElement {
  return (
    <span className="inline-flex shrink-0 gap-1.5 font-mono text-xs">
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
