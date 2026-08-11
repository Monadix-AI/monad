import type { DeveloperSettings, LogCleanupPreview, LogCleanupResult, PreviewLogCleanupRequest } from '@monad/protocol';

import { Delete02Icon, LoaderPinwheelIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useClearLogsMutation, usePreviewLogCleanupMutation, useSetDeveloperMutation } from '@monad/client-rtk';
import { Button, Confirm, Input, Label } from '@monad/ui';
import { type SyntheticEvent, useEffect, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { SwitchSetting } from '#/components/ui/switch-setting';

interface SystemLogSettingsProps {
  developer?: DeveloperSettings;
  isError: boolean;
  isLoading: boolean;
  onRetry: () => void;
}

export function SystemLogSettings({ developer, isError, isLoading, onRetry }: SystemLogSettingsProps) {
  const t = useT();

  if (isError || isLoading || !developer) {
    const showError = isError || (!isLoading && !developer);
    return (
      <section className="flex flex-col gap-3">
        <h3 className="font-semibold text-sm">{t('web.settings.system.logs')}</h3>
        {showError ? (
          <div
            aria-live="polite"
            className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 px-3 py-2.5"
          >
            <span className="text-destructive text-xs">{t('web.settings.system.logsLoadFailed')}</span>
            <Button
              onClick={onRetry}
              size="sm"
              variant="outline"
            >
              {t('web.settings.system.tryAgain')}
            </Button>
          </div>
        ) : (
          <p
            aria-live="polite"
            className="text-muted-foreground text-xs"
          >
            {t('web.settings.system.logsLoading')}
          </p>
        )}
      </section>
    );
  }

  return <LoadedSystemLogSettings developer={developer} />;
}

function LoadedSystemLogSettings({ developer }: { developer: DeveloperSettings }) {
  const t = useT();
  const serverPolicy = developer.logs.autoCleanup;
  const [draftEnabled, setDraftEnabled] = useState(serverPolicy.enabled);
  const [retentionInput, setRetentionInput] = useState(String(serverPolicy.retentionDays));
  const [pendingProposal, setPendingProposal] = useState<PreviewLogCleanupRequest>();
  const [previewResult, setPreviewResult] = useState<LogCleanupPreview>();
  const [previewFailed, setPreviewFailed] = useState(false);
  const [policyDialogOpen, setPolicyDialogOpen] = useState(false);
  const [policySaved, setPolicySaved] = useState(false);
  const [policySaveFailed, setPolicySaveFailed] = useState(false);
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [clearResult, setClearResult] = useState<LogCleanupResult>();
  const [clearFailed, setClearFailed] = useState(false);
  const [previewLogCleanup, { isLoading: isPreviewing }] = usePreviewLogCleanupMutation();
  const [setDeveloper, { isLoading: isSaving }] = useSetDeveloperMutation();
  const [clearLogs, { isLoading: isClearing }] = useClearLogsMutation();

  useEffect(() => {
    setDraftEnabled(serverPolicy.enabled);
    setRetentionInput(String(serverPolicy.retentionDays));
  }, [serverPolicy.enabled, serverPolicy.retentionDays]);

  const retentionDays = Number(retentionInput);
  const validRetention = Number.isInteger(retentionDays) && retentionDays >= 1 && retentionDays <= 30;
  const dirty =
    draftEnabled !== serverPolicy.enabled || (validRetention && retentionDays !== serverPolicy.retentionDays);
  const busy = isPreviewing || isSaving;

  function resetDraft() {
    setDraftEnabled(serverPolicy.enabled);
    setRetentionInput(String(serverPolicy.retentionDays));
  }

  function updateDraftEnabled(enabled: boolean) {
    setDraftEnabled(enabled);
    setPreviewFailed(false);
    setPolicySaveFailed(false);
    setPolicySaved(false);
  }

  function updateRetention(value: string) {
    setRetentionInput(value);
    setPreviewFailed(false);
    setPolicySaveFailed(false);
    setPolicySaved(false);
  }

  async function savePolicy(proposal: PreviewLogCleanupRequest): Promise<boolean> {
    setPolicySaveFailed(false);
    try {
      await setDeveloper({ logs: { autoCleanup: proposal } }).unwrap();
      setDraftEnabled(proposal.enabled);
      setRetentionInput(String(proposal.retentionDays));
      setPendingProposal(undefined);
      setPreviewResult(undefined);
      setPolicySaved(true);
      return true;
    } catch {
      resetDraft();
      setPolicySaveFailed(true);
      return false;
    }
  }

  async function previewPolicy(proposal: PreviewLogCleanupRequest) {
    setPendingProposal(proposal);
    setPreviewFailed(false);
    setPolicySaveFailed(false);
    try {
      const result = await previewLogCleanup(proposal).unwrap();
      setPreviewResult(result);
      if (result.files === 0) {
        await savePolicy(proposal);
        return;
      }
      setPolicyDialogOpen(true);
    } catch {
      resetDraft();
      setPreviewFailed(true);
    }
  }

  async function handleSubmit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    if (!validRetention || !dirty || busy) return;
    const proposal = { enabled: draftEnabled, retentionDays };
    const stricter = proposal.enabled && (!serverPolicy.enabled || proposal.retentionDays < serverPolicy.retentionDays);
    if (stricter) {
      await previewPolicy(proposal);
      return;
    }
    await savePolicy(proposal);
  }

  function handlePolicyDialogOpenChange(open: boolean) {
    setPolicyDialogOpen(open);
    if (open) return;
    setPendingProposal(undefined);
    setPreviewResult(undefined);
    resetDraft();
  }

  async function handleClearLogs(): Promise<boolean> {
    setClearFailed(false);
    try {
      setClearResult(await clearLogs().unwrap());
      return true;
    } catch {
      setClearResult(undefined);
      setClearFailed(true);
      return false;
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <h3 className="font-semibold text-sm">{t('web.settings.system.logs')}</h3>
      <form
        className="flex flex-col gap-2"
        onSubmit={handleSubmit}
      >
        <SwitchSetting
          checked={draftEnabled}
          className="rounded-md border px-3 py-2.5"
          description={t('web.settings.system.autoLogCleanupDesc')}
          disabled={busy}
          onCheckedChange={updateDraftEnabled}
          title={t('web.settings.system.autoLogCleanup')}
        />

        <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-2.5">
          <div className="flex min-w-0 flex-col gap-0.5">
            <Label
              className="text-sm"
              htmlFor="log-retention-days"
            >
              {t('web.settings.system.retentionPeriod')}
            </Label>
            <span className="text-muted-foreground text-xs">{t('web.settings.system.retentionPeriodDesc')}</span>
          </div>
          <Input
            aria-describedby="log-retention-days-help"
            className="w-20"
            disabled={!draftEnabled || busy}
            id="log-retention-days"
            max={30}
            min={1}
            onChange={(event) => updateRetention(event.target.value)}
            required
            step={1}
            type="number"
            value={retentionInput}
          />
          <span
            className="sr-only"
            id="log-retention-days-help"
          >
            {t('web.settings.system.retentionPeriodDesc')}
          </span>
        </div>

        <div className="flex items-center justify-end gap-3">
          {policySaved ? (
            <span
              aria-live="polite"
              className="text-muted-foreground text-xs"
            >
              {t('web.settings.system.cleanupPolicySaved')}
            </span>
          ) : null}
          <Button
            disabled={!dirty || !validRetention || busy}
            type="submit"
          >
            {busy ? (
              <HugeiconsIcon
                className="size-3.5 animate-spin"
                icon={LoaderPinwheelIcon}
              />
            ) : null}
            {t('web.settings.system.saveCleanupPolicy')}
          </Button>
        </div>
      </form>

      {previewFailed && pendingProposal ? (
        <div
          aria-live="polite"
          className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 px-3 py-2.5"
        >
          <span className="text-destructive text-xs">{t('web.settings.system.cleanupPreviewFailed')}</span>
          <Button
            disabled={busy}
            onClick={() => void previewPolicy(pendingProposal)}
            size="sm"
            variant="outline"
          >
            {t('web.settings.system.tryAgain')}
          </Button>
        </div>
      ) : null}

      {policySaveFailed ? (
        <p
          aria-live="polite"
          className="text-destructive text-xs"
        >
          {t('web.settings.system.cleanupPolicySaveFailed')}
        </p>
      ) : null}

      {developer.developerMode === true ? (
        <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-2.5">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm">{t('web.settings.system.liveEventReplay')}</span>
            <span className="text-muted-foreground text-xs">{t('web.settings.system.liveEventReplayDesc')}</span>
          </div>
          <Button
            asChild
            size="sm"
            variant="outline"
          >
            <a
              href="/developer/live-event-replay"
              rel="noopener noreferrer"
              target="_blank"
            >
              {t('web.settings.system.openLiveEventReplay')}
            </a>
          </Button>
        </div>
      ) : null}

      {developer.developerMode === true ? (
        <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-2.5">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm">{t('web.settings.system.clearLogs')}</span>
            <span className="text-muted-foreground text-xs">{t('web.settings.system.clearLogsDesc')}</span>
          </div>
          <Button
            className="gap-1.5"
            disabled={isClearing}
            onClick={() => {
              setClearResult(undefined);
              setClearFailed(false);
              setClearDialogOpen(true);
            }}
            size="sm"
            variant="destructive"
          >
            {isClearing ? (
              <HugeiconsIcon
                className="size-3.5 animate-spin"
                icon={LoaderPinwheelIcon}
              />
            ) : (
              <HugeiconsIcon
                className="size-3.5"
                icon={Delete02Icon}
              />
            )}
            {t('web.settings.system.clearLogs')}
          </Button>
        </div>
      ) : null}

      {clearResult ? (
        <p
          aria-live="polite"
          className={clearResult.filesFailed > 0 ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}
        >
          {clearResult.filesFailed > 0
            ? `${t('web.settings.system.clearLogsSuccess', {
                bytes: formatBytes(clearResult.bytesFreed),
                count: clearResult.filesCleared
              })} ${t('web.settings.system.clearLogsFailureCount', { count: clearResult.filesFailed })}`
            : t('web.settings.system.clearLogsSuccess', {
                bytes: formatBytes(clearResult.bytesFreed),
                count: clearResult.filesCleared
              })}
        </p>
      ) : null}

      {clearFailed ? (
        <p
          aria-live="polite"
          className="text-destructive text-xs"
        >
          {t('web.settings.system.clearLogsFailed')}
        </p>
      ) : null}

      <Confirm
        cancelLabel={t('web.common.cancel')}
        confirmLabel={t('web.settings.system.applyCleanupPolicy')}
        confirmVariant="destructive"
        description={t('web.settings.system.cleanupConfirmDescription', { count: previewResult?.files ?? 0 })}
        error={policySaveFailed ? t('web.settings.system.cleanupPolicySaveFailed') : undefined}
        onConfirm={() => {
          if (!pendingProposal) return;
          void savePolicy(pendingProposal).then((saved) => {
            if (saved) setPolicyDialogOpen(false);
          });
        }}
        onOpenChange={handlePolicyDialogOpenChange}
        open={policyDialogOpen}
        pending={isSaving}
        pendingLabel={t('web.common.saving')}
        title={t('web.settings.system.cleanupConfirmTitle', {
          count: pendingProposal?.retentionDays ?? retentionDays
        })}
      />

      <Confirm
        cancelLabel={t('web.common.cancel')}
        confirmLabel={t('web.settings.system.clearLogs')}
        confirmVariant="destructive"
        description={t('web.settings.system.clearLogsConfirmDescription')}
        error={clearFailed ? t('web.settings.system.clearLogsFailed') : undefined}
        onConfirm={() => {
          void handleClearLogs().then((cleared) => {
            if (cleared) setClearDialogOpen(false);
          });
        }}
        onOpenChange={setClearDialogOpen}
        open={clearDialogOpen}
        pending={isClearing}
        pendingLabel={t('web.settings.system.clearingLogs')}
        title={t('web.settings.system.clearLogsConfirmTitle')}
      />
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)} ${unit}`;
}
