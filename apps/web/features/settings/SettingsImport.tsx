'use client';

import type {
  ImportSettingsAction,
  ImportSettingsApplyResult,
  ImportSettingsCategory,
  ImportSettingsItem,
  ImportSettingsPreview,
  ImportSettingsRisk,
  ImportSettingsSource
} from '@monad/protocol';

import {
  Alert01Icon,
  Cancel01Icon,
  CheckIcon,
  ChevronDownIcon,
  FileInputIcon,
  InformationCircleIcon,
  LoaderPinwheelIcon,
  RotateLeft01Icon,
  Shield01Icon,
  SlidersHorizontalIcon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useApplySettingsImportMutation, usePreviewSettingsImportMutation } from '@monad/client-rtk';
import { Badge, Button, cn, Input, Label, ScrollArea, Separator, Switch } from '@monad/ui';
import { useMemo, useState } from 'react';

import { useT } from '@/components/I18nProvider';

interface Props {
  onClose: () => void;
}

const SOURCES: ImportSettingsSource[] = [
  'auto',
  'codex',
  'claude-code',
  'hermes',
  'openclaw',
  'cursor',
  'claude-desktop',
  'vscode',
  'aider',
  'continue',
  'roo-code'
];

const CATEGORIES: ImportSettingsCategory[] = [
  'skills',
  'mcpServers',
  'modelProviders',
  'modelProfiles',
  'modelRoles',
  'credentials',
  'hooks',
  'sandbox',
  'approvals',
  'tools',
  'agents',
  'plugins'
];

const ITEM_GRID_CLASS = 'grid min-w-[48rem] grid-cols-[2.5rem_7rem_5rem_minmax(8rem,1fr)_minmax(12rem,1.5fr)]';

const PATH_SHORTCUTS: { label: string; from: ImportSettingsSource; path: string }[] = [
  { label: 'Codex config', from: 'codex', path: '~/.codex/config.toml' },
  { label: 'Codex skills', from: 'codex', path: '~/.codex/skills' },
  { label: 'Claude Code', from: 'claude-code', path: '~/.claude/settings.json' },
  { label: 'Claude project', from: 'claude-code', path: '.claude' },
  {
    label: 'Claude Desktop',
    from: 'claude-desktop',
    path: '~/Library/Application Support/Claude/claude_desktop_config.json'
  },
  { label: 'Claude Desktop Win', from: 'claude-desktop', path: '%APPDATA%\\Claude\\claude_desktop_config.json' },
  { label: 'Cursor MCP', from: 'cursor', path: '~/.cursor/mcp.json' }
];

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return error instanceof Error ? error.message : String(error);
}

function canApplyItem(item: ImportSettingsItem): boolean {
  return item.action === 'add' || item.action === 'update';
}

function isSafeItem(item: ImportSettingsItem): boolean {
  return item.action === 'add' && item.risk === 'low';
}

function actionVariant(action: ImportSettingsAction): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (action === 'add' || action === 'update') return 'default';
  if (action === 'skip') return 'secondary';
  if (action === 'conflict') return 'destructive';
  return 'outline';
}

function riskVariant(risk: ImportSettingsRisk): 'secondary' | 'destructive' | 'outline' {
  if (risk === 'low') return 'secondary';
  if (risk === 'high') return 'destructive';
  return 'outline';
}

function previewCounts(preview: ImportSettingsPreview | undefined) {
  const items = preview?.items ?? [];
  return {
    total: items.length,
    add: items.filter((item) => item.action === 'add').length,
    update: items.filter((item) => item.action === 'update').length,
    conflict: items.filter((item) => item.action === 'conflict').length,
    high: items.filter((item) => item.risk === 'high').length
  };
}

function categoryCounts(preview: ImportSettingsPreview | undefined) {
  const items = preview?.items ?? [];
  return CATEGORIES.map((name) => ({ name, count: items.filter((item) => item.category === name).length })).filter(
    (entry) => entry.count > 0
  );
}

function skippedReason(result: ImportSettingsApplyResult | undefined, id: string): string | undefined {
  return result?.skipped.find((item) => item.id === id)?.reason;
}

export function SettingsImport({ onClose }: Props) {
  const t = useT();
  const [from, setFrom] = useState<ImportSettingsSource>('auto');
  const [path, setPath] = useState('');
  const [replace, setReplace] = useState(false);
  const [category, setCategory] = useState<ImportSettingsCategory | 'all'>('all');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<ImportSettingsPreview | undefined>();
  const [result, setResult] = useState<ImportSettingsApplyResult | undefined>();
  const [previewImport, previewState] = usePreviewSettingsImportMutation();
  const [applyImport, applyState] = useApplySettingsImportMutation();

  const visibleItems = useMemo(() => {
    const items = preview?.items ?? [];
    return category === 'all' ? items : items.filter((item) => item.category === category);
  }, [category, preview]);

  const selectedItems = useMemo(
    () => (preview?.items ?? []).filter((item) => selectedIds.has(item.id) && canApplyItem(item)),
    [preview, selectedIds]
  );
  const counts = previewCounts(preview);
  const categories = categoryCounts(preview);
  const appliedIds = useMemo(() => new Set(result?.applied ?? []), [result]);
  const error = previewState.error ?? applyState.error;
  const busy = previewState.isLoading || applyState.isLoading;

  async function handlePreview() {
    const next = await previewImport({ from, path, replace }).unwrap();
    setPreview(next);
    setResult(undefined);
    setExpandedIds(new Set());
    setSelectedIds(new Set(next.items.filter(isSafeItem).map((item) => item.id)));
  }

  async function handleApply() {
    if (!preview || selectedItems.length === 0) return;
    const select = selectedItems.map((item) => item.id);
    const hashes = Object.fromEntries(selectedItems.map((item) => [item.id, item.hash]));
    const applied = await applyImport({ from, path, replace, select, allSafe: false, hashes }).unwrap();
    setResult(applied);
    setPreview(applied.preview);
    setSelectedIds(new Set());
  }

  function toggleItem(item: ImportSettingsItem) {
    if (!canApplyItem(item)) return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
  }

  function selectSafe() {
    setSelectedIds(new Set((preview?.items ?? []).filter(isSafeItem).map((item) => item.id)));
  }

  function selectVisibleApplyable() {
    setSelectedIds(new Set(visibleItems.filter(canApplyItem).map((item) => item.id)));
  }

  function toggleExpanded(id: string) {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function applyShortcut(shortcut: (typeof PATH_SHORTCUTS)[number]) {
    setFrom(shortcut.from);
    setPath(shortcut.path);
    setResult(undefined);
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div className="flex items-center gap-2">
          <HugeiconsIcon
            className="size-4 text-muted-foreground"
            icon={FileInputIcon}
          />
          <span className="font-semibold text-sm">{t('web.settings.import')}</span>
        </div>
        <Button
          aria-label={t('web.common.close')}
          className="size-7"
          onClick={onClose}
          size="icon"
          variant="ghost"
        >
          <HugeiconsIcon icon={Cancel01Icon} />
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-5 p-6">
          <section className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <HugeiconsIcon
                className="size-4 text-muted-foreground"
                icon={SlidersHorizontalIcon}
              />
              <h3 className="font-semibold text-sm">{t('web.settings.import.source')}</h3>
            </div>
            <div className="grid gap-3 md:grid-cols-[12rem_1fr]">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="settings-import-source">{t('web.settings.import.from')}</Label>
                <select
                  className="h-8 rounded-(--radius-sm) border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30"
                  disabled={busy}
                  id="settings-import-source"
                  onChange={(event) => setFrom(event.target.value as ImportSettingsSource)}
                  value={from}
                >
                  {SOURCES.map((source) => (
                    <option
                      key={source}
                      value={source}
                    >
                      {source}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="settings-import-path">{t('web.settings.import.path')}</Label>
                <Input
                  disabled={busy}
                  id="settings-import-path"
                  onChange={(event) => setPath(event.target.value)}
                  placeholder={t('web.settings.import.pathPlaceholder')}
                  value={path}
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>{t('web.settings.import.shortcuts')}</Label>
              <div className="flex flex-wrap gap-1.5">
                {PATH_SHORTCUTS.map((shortcut) => (
                  <Button
                    disabled={busy}
                    key={`${shortcut.from}:${shortcut.path}`}
                    onClick={() => applyShortcut(shortcut)}
                    size="xs"
                    type="button"
                    variant="outline"
                  >
                    {shortcut.label}
                  </Button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <HugeiconsIcon
                  className="size-3.5 shrink-0 text-muted-foreground"
                  icon={Alert01Icon}
                />
                <span className="text-muted-foreground text-xs">{t('web.settings.import.replaceDesc')}</span>
              </div>
              <Switch
                aria-label={t('web.settings.import.replace')}
                checked={replace}
                disabled={busy}
                onCheckedChange={setReplace}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                className="gap-1.5"
                disabled={busy || path.trim().length === 0}
                onClick={handlePreview}
                size="sm"
              >
                {previewState.isLoading ? (
                  <HugeiconsIcon
                    className="size-3.5 animate-spin"
                    icon={LoaderPinwheelIcon}
                  />
                ) : (
                  <HugeiconsIcon
                    className="size-3.5"
                    icon={RotateLeft01Icon}
                  />
                )}
                {t('web.settings.import.preview')}
              </Button>
              {preview ? (
                <>
                  <Button
                    disabled={busy}
                    onClick={selectSafe}
                    size="sm"
                    variant="outline"
                  >
                    <HugeiconsIcon
                      className="size-3.5"
                      icon={Shield01Icon}
                    />
                    {t('web.settings.import.selectSafe')}
                  </Button>
                  <Button
                    disabled={busy || visibleItems.every((item) => !canApplyItem(item))}
                    onClick={selectVisibleApplyable}
                    size="sm"
                    variant="outline"
                  >
                    {t('web.settings.import.selectVisible')}
                  </Button>
                  <Button
                    disabled={busy || selectedIds.size === 0}
                    onClick={() => setSelectedIds(new Set())}
                    size="sm"
                    variant="ghost"
                  >
                    {t('web.settings.import.clearSelection')}
                  </Button>
                </>
              ) : null}
            </div>
          </section>

          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-sm">
              {errorMessage(error)}
            </div>
          ) : null}

          {preview ? (
            <>
              <Separator />
              <section className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">{t('web.settings.import.total', { count: counts.total })}</Badge>
                    <Badge variant="outline">{t('web.settings.import.add', { count: counts.add })}</Badge>
                    <Badge variant="outline">{t('web.settings.import.update', { count: counts.update })}</Badge>
                    <Badge variant={counts.conflict ? 'destructive' : 'secondary'}>
                      {t('web.settings.import.conflict', { count: counts.conflict })}
                    </Badge>
                    <Badge variant={counts.high ? 'destructive' : 'secondary'}>
                      {t('web.settings.import.highRisk', { count: counts.high })}
                    </Badge>
                  </div>
                </div>

                <div
                  aria-label={t('web.settings.import.category')}
                  className="flex flex-wrap gap-1.5"
                  role="tablist"
                >
                  <Button
                    aria-selected={category === 'all'}
                    onClick={() => setCategory('all')}
                    role="tab"
                    size="xs"
                    type="button"
                    variant={category === 'all' ? 'secondary' : 'ghost'}
                  >
                    {t('web.settings.import.allCategories')}
                    <Badge
                      className="px-1.5 py-0 text-[10px]"
                      variant="outline"
                    >
                      {counts.total}
                    </Badge>
                  </Button>
                  {categories.map(({ name, count }) => (
                    <Button
                      aria-selected={category === name}
                      key={name}
                      onClick={() => setCategory(name)}
                      role="tab"
                      size="xs"
                      type="button"
                      variant={category === name ? 'secondary' : 'ghost'}
                    >
                      {name}
                      <Badge
                        className="px-1.5 py-0 text-[10px]"
                        variant="outline"
                      >
                        {count}
                      </Badge>
                    </Button>
                  ))}
                </div>

                {preview.warnings.length ? (
                  <div className="flex flex-col gap-1 rounded-md border bg-muted/30 px-3 py-2">
                    {preview.warnings.map((warning) => (
                      <div
                        className="flex gap-2 text-muted-foreground text-xs"
                        key={warning}
                      >
                        <HugeiconsIcon
                          className="mt-0.5 size-3 shrink-0"
                          icon={Alert01Icon}
                        />
                        <span>{warning}</span>
                      </div>
                    ))}
                  </div>
                ) : null}

                <div className="overflow-x-auto rounded-md border">
                  <div className={cn(ITEM_GRID_CLASS, 'border-b bg-muted/40 px-3 py-2 text-muted-foreground text-xs')}>
                    <span />
                    <span>{t('web.settings.import.action')}</span>
                    <span>{t('web.settings.import.risk')}</span>
                    <span>{t('web.settings.import.target')}</span>
                    <span>{t('web.settings.import.reason')}</span>
                  </div>
                  {visibleItems.length === 0 ? (
                    <div className="px-3 py-8 text-center text-muted-foreground text-sm">
                      {t('web.settings.import.empty')}
                    </div>
                  ) : (
                    visibleItems.map((item) => {
                      const applyable = canApplyItem(item);
                      const selected = selectedIds.has(item.id);
                      const expanded = expandedIds.has(item.id);
                      const skipped = skippedReason(result, item.id);
                      const applied = appliedIds.has(item.id);
                      return (
                        <div
                          className={cn(
                            'border-b last:border-b-0',
                            applied ? 'bg-primary/5' : skipped ? 'bg-muted/35' : null
                          )}
                          key={item.id}
                        >
                          <button
                            className={cn(
                              ITEM_GRID_CLASS,
                              'w-full items-start gap-2 px-3 py-2 text-left',
                              applyable ? 'hover:bg-muted/40' : 'bg-muted/20 hover:bg-muted/35'
                            )}
                            onClick={() => (applyable ? toggleItem(item) : toggleExpanded(item.id))}
                            type="button"
                          >
                            <span
                              className={cn(
                                'mt-1 flex size-4 items-center justify-center rounded border',
                                selected
                                  ? 'border-primary bg-primary text-primary-foreground'
                                  : applied
                                    ? 'border-primary text-primary'
                                    : 'border-input bg-background'
                              )}
                            >
                              {selected || applied ? (
                                <HugeiconsIcon
                                  className="size-3"
                                  icon={CheckIcon}
                                />
                              ) : null}
                            </span>
                            <span className="flex flex-col gap-1">
                              <span className="flex items-center gap-1.5">
                                <Badge
                                  className="max-w-fit"
                                  variant={actionVariant(item.action)}
                                >
                                  {item.action}
                                </Badge>
                                {!applyable ? (
                                  <HugeiconsIcon
                                    className="size-3 text-muted-foreground"
                                    icon={InformationCircleIcon}
                                  />
                                ) : skipped ? (
                                  <HugeiconsIcon
                                    className="size-3 text-muted-foreground"
                                    icon={Alert01Icon}
                                  />
                                ) : null}
                              </span>
                              <span className="font-mono text-[10px] text-muted-foreground">{item.id}</span>
                            </span>
                            <span>
                              <Badge variant={riskVariant(item.risk)}>{item.risk}</Badge>
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate font-medium text-sm">{item.target}</span>
                              <span className="block truncate text-muted-foreground text-xs">{item.category}</span>
                            </span>
                            <span className="min-w-0 text-muted-foreground text-xs">
                              <span className="line-clamp-2">{skipped ?? item.reason}</span>
                              {item.summary ? (
                                <span className="mt-1 block truncate font-mono">{item.summary}</span>
                              ) : null}
                              {!applyable || skipped ? (
                                <span className="mt-1 inline-flex items-center gap-1 text-foreground">
                                  <HugeiconsIcon
                                    className={cn('size-3 transition-transform', expanded ? 'rotate-180' : null)}
                                    icon={ChevronDownIcon}
                                  />
                                  {t('web.settings.import.details')}
                                </span>
                              ) : null}
                            </span>
                          </button>
                          {expanded || skipped ? (
                            <div className="min-w-[48rem] px-3 pb-3 pl-[12.5rem] text-xs">
                              <div className="rounded-md border bg-background px-3 py-2">
                                <div className="font-medium text-foreground">
                                  {skipped
                                    ? t('web.settings.import.skipped')
                                    : item.action === 'conflict'
                                      ? t('web.settings.import.conflictDetail')
                                      : item.action === 'manual'
                                        ? t('web.settings.import.manualDetail')
                                        : t('web.settings.import.skipDetail')}
                                </div>
                                <div className="mt-1 text-muted-foreground">{skipped ?? item.reason}</div>
                                <div className="mt-2 grid gap-1 font-mono text-[11px] text-muted-foreground">
                                  <span>{item.source}</span>
                                  {item.summary ? <span>{item.summary}</span> : null}
                                </div>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      );
                    })
                  )}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-muted-foreground text-xs">
                    {t('web.settings.import.selected', { count: selectedItems.length })}
                  </span>
                  <Button
                    className="gap-1.5"
                    disabled={busy || selectedItems.length === 0}
                    onClick={handleApply}
                    size="sm"
                  >
                    {applyState.isLoading ? (
                      <HugeiconsIcon
                        className="size-3.5 animate-spin"
                        icon={LoaderPinwheelIcon}
                      />
                    ) : (
                      <HugeiconsIcon
                        className="size-3.5"
                        icon={CheckIcon}
                      />
                    )}
                    {t('web.settings.import.apply')}
                  </Button>
                </div>
              </section>
            </>
          ) : (
            <div className="rounded-md border border-dashed px-4 py-10 text-center text-muted-foreground text-sm">
              {t('web.settings.import.noPreview')}
            </div>
          )}

          {result ? (
            <div className="rounded-md border bg-muted/20 px-3 py-2 text-sm">
              <div className="font-medium">{t('web.settings.import.result')}</div>
              <div className="mt-1 text-muted-foreground text-xs">
                {t('web.settings.import.resultDesc', {
                  applied: result.applied.length,
                  skipped: result.skipped.length
                })}
              </div>
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}
