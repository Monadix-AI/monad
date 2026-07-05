import type {
  NativeCliAgentPresetView,
  NativeCliSettingsImportItem,
  NativeCliSettingsImportPreview
} from '@monad/protocol';

import { FileInputIcon, LoaderPinwheelIcon, Search01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  useApplyNativeCliSettingsImportMutation,
  useListNativeCliSettingsImportCandidatesQuery,
  usePreviewNativeCliSettingsImportMutation
} from '@monad/client-rtk';
import { Button, cn, Input, isProductIconId, Label, ProductIcon, ScrollArea } from '@monad/ui';
import { useEffect, useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { canApplyImportItem, errorMessage } from './native-cli-agent-settings-utils';

export function NativeCliSettingsImportDialog({
  preset,
  onApplied,
  onClose
}: {
  preset: NativeCliAgentPresetView;
  onApplied: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const candidatesQ = useListNativeCliSettingsImportCandidatesQuery(preset.id);
  const [path, setPath] = useState('');
  const [selectedCandidatePaths, setSelectedCandidatePaths] = useState<Set<string>>(new Set());
  const [replace, setReplace] = useState(false);
  const [preview, setPreview] = useState<NativeCliSettingsImportPreview | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<{ applied: string[]; skipped: Array<{ id: string; reason: string }> } | null>(
    null
  );
  const [previewImport, previewState] = usePreviewNativeCliSettingsImportMutation();
  const [applyImport, applyState] = useApplyNativeCliSettingsImportMutation();
  const candidates = candidatesQ.data ?? [];
  const busy = candidatesQ.isLoading || previewState.isLoading || applyState.isLoading;
  const error = candidatesQ.error ?? previewState.error ?? applyState.error;
  const applyableItems = (preview?.items ?? []).filter(canApplyImportItem);
  const selectedCandidateSources = candidates
    .filter((candidate) => selectedCandidatePaths.has(candidate.path))
    .map((candidate) => ({ path: candidate.path, scope: candidate.scope, label: candidate.label }));
  const migrationSourceRequest =
    selectedCandidateSources.length > 0
      ? { sources: selectedCandidateSources }
      : path.trim()
        ? { path: path.trim() }
        : {};

  useEffect(() => {
    if (candidates.length > 0 && selectedCandidatePaths.size === 0) {
      setSelectedCandidatePaths(new Set(candidates.map((candidate) => candidate.path)));
    }
  }, [candidates, selectedCandidatePaths.size]);

  async function handlePreview() {
    const next = await previewImport({ name: preset.id, ...migrationSourceRequest, replace }).unwrap();
    setPreview(next);
    setResult(null);
    setSelectedIds(
      new Set(next.items.filter((item) => canApplyImportItem(item) && item.risk === 'low').map((i) => i.id))
    );
  }

  async function handleApply() {
    if (!preview) return;
    const selected = preview.items.filter((item) => selectedIds.has(item.id) && canApplyImportItem(item));
    const next = await applyImport({
      name: preset.id,
      ...migrationSourceRequest,
      replace,
      select: selected.map((item) => item.id),
      hashes: Object.fromEntries(selected.map((item) => [item.id, item.hash]))
    }).unwrap();
    setPreview(next.preview);
    setSelectedIds(new Set());
    setResult({ applied: next.applied, skipped: next.skipped });
    if (next.applied.length > 0) onApplied();
  }

  function toggleItem(item: NativeCliSettingsImportItem) {
    if (!canApplyImportItem(item)) return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
  }

  function toggleCandidate(path: string) {
    setSelectedCandidatePaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return (
    <div className="flex max-h-[inherit] flex-col">
      <DialogHeader className="border-b bg-card/80 px-5 py-4 pr-12">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-background">
            {isProductIconId(preset.productIcon) ? (
              <ProductIcon
                className="size-6"
                product={preset.productIcon}
              />
            ) : null}
          </span>
          <span className="min-w-0">
            <DialogTitle className="truncate text-base">{t('web.nativeCli.importSettings')}</DialogTitle>
            <DialogDescription className="mt-1 text-xs">{preset.label}</DialogDescription>
          </span>
        </div>
      </DialogHeader>
      <ScrollArea className="min-h-0 flex-1 bg-muted/10">
        <div className="flex flex-col gap-4 p-5">
          {error ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-xs">
              {errorMessage(error)}
            </p>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="native-cli-settings-import-path">{t('web.settings.import.path')}</Label>
              <Input
                disabled={busy}
                id="native-cli-settings-import-path"
                onChange={(event) => setPath(event.target.value)}
                placeholder={t('web.settings.import.pathPlaceholder')}
                value={path}
              />
            </div>
            <div className="flex items-end gap-2">
              <label className="flex h-8 items-center gap-2 rounded-md border px-2.5 text-xs">
                <input
                  checked={replace}
                  disabled={busy}
                  onChange={(event) => setReplace(event.target.checked)}
                  type="checkbox"
                />
                {t('web.settings.import.replace')}
              </label>
              <Button
                disabled={busy || (selectedCandidateSources.length === 0 && !path.trim())}
                onClick={handlePreview}
                size="sm"
                type="button"
              >
                {busy ? (
                  <HugeiconsIcon
                    className="animate-spin"
                    icon={LoaderPinwheelIcon}
                  />
                ) : (
                  <HugeiconsIcon icon={Search01Icon} />
                )}
                {t('web.settings.import.preview')}
              </Button>
            </div>
          </div>
          {candidates.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {candidates.map((candidate) => (
                <Button
                  disabled={busy}
                  key={candidate.path}
                  onClick={() => toggleCandidate(candidate.path)}
                  size="sm"
                  type="button"
                  variant={selectedCandidatePaths.has(candidate.path) ? 'default' : 'outline'}
                >
                  {candidate.scope}: {candidate.path}
                </Button>
              ))}
            </div>
          ) : candidatesQ.isLoading ? null : (
            <p className="text-muted-foreground text-xs">{t('web.nativeCli.importNoCandidates')}</p>
          )}
          {preview ? (
            <div className="overflow-hidden rounded-md border bg-card">
              <div className="grid grid-cols-[2rem_7rem_minmax(0,1fr)_5rem] gap-2 border-b px-3 py-2 text-muted-foreground text-xs">
                <span />
                <span>{t('web.settings.import.action')}</span>
                <span>{t('web.settings.import.target')}</span>
                <span>{t('web.settings.import.risk')}</span>
              </div>
              {preview.items.length === 0 ? (
                <p className="px-3 py-4 text-center text-muted-foreground text-xs">{t('web.settings.import.empty')}</p>
              ) : (
                preview.items.map((item) => (
                  <button
                    className={cn(
                      'grid w-full grid-cols-[2rem_7rem_minmax(0,1fr)_5rem] gap-2 px-3 py-2 text-left text-xs',
                      canApplyImportItem(item) && 'hover:bg-muted/60'
                    )}
                    disabled={!canApplyImportItem(item)}
                    key={item.id}
                    onClick={() => toggleItem(item)}
                    type="button"
                  >
                    <span>
                      <input
                        checked={selectedIds.has(item.id)}
                        disabled={!canApplyImportItem(item)}
                        readOnly
                        type="checkbox"
                      />
                    </span>
                    <span>{item.action}</span>
                    <span className="min-w-0 truncate">
                      {item.target}
                      {item.summary ? <span className="ml-2 text-muted-foreground">{item.summary}</span> : null}
                    </span>
                    <span>{item.risk}</span>
                  </button>
                ))
              )}
            </div>
          ) : null}
          {result ? (
            <p className="rounded-md border bg-background px-3 py-2 text-xs">
              {t('web.settings.import.resultDesc', { applied: result.applied.length, skipped: result.skipped.length })}
            </p>
          ) : null}
        </div>
      </ScrollArea>
      <div className="flex justify-end gap-2 border-t bg-card/80 px-5 py-3">
        <Button
          onClick={onClose}
          size="sm"
          type="button"
          variant="ghost"
        >
          {t('web.common.close')}
        </Button>
        <Button
          disabled={busy || applyableItems.length === 0 || selectedIds.size === 0}
          onClick={handleApply}
          size="sm"
          type="button"
        >
          {applyState.isLoading ? (
            <HugeiconsIcon
              className="animate-spin"
              icon={LoaderPinwheelIcon}
            />
          ) : (
            <HugeiconsIcon icon={FileInputIcon} />
          )}
          {t('web.settings.import.apply')}
        </Button>
      </div>
    </div>
  );
}
