import type { SystemUpgradeStatus } from '@monad/protocol';

import { Download04Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useGetSystemUpgradeQuery, useStartSystemUpgradeMutation } from '@monad/client-rtk';
import { Button, cn, Tooltip, TooltipContent, TooltipTrigger } from '@monad/ui';
import { useEffect, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { ThemeToggle } from '#/components/ThemeToggle';
import { watchUpgradeRestartAndReload } from '#/lib/monad-store';

const BACKGROUND_CHECK_INTERVAL_MS = 5 * 60_000;

function upgradeStatusIsActive(stage: SystemUpgradeStatus['stage'] | undefined): boolean {
  return (
    stage === 'checking' ||
    stage === 'downloading' ||
    stage === 'verifying' ||
    stage === 'installing' ||
    stage === 'restarting'
  );
}

export function SidebarUpgradeControl({
  daemonBaseUrl,
  daemonOnline,
  daemonVersion,
  hasUpgradeHint
}: {
  daemonBaseUrl: string;
  daemonOnline: boolean;
  daemonVersion?: string;
  hasUpgradeHint?: boolean;
}) {
  const t = useT();
  const [initialCheckPending, setInitialCheckPending] = useState(true);
  const [upgradeInitiated, setUpgradeInitiated] = useState(false);
  const [upgradePolling, setUpgradePolling] = useState(false);
  const [startSystemUpgrade, { isLoading: isStartingUpgrade }] = useStartSystemUpgradeMutation();
  const { data: upgradeStatus } = useGetSystemUpgradeQuery(undefined, {
    pollingInterval: initialCheckPending || upgradeInitiated || upgradePolling ? 1000 : BACKGROUND_CHECK_INTERVAL_MS,
    refetchOnMountOrArgChange: true,
    skip: !daemonOnline
  });
  const stage = upgradeStatus?.stage;
  const upgradeActive = upgradeStatusIsActive(stage);
  const upgradeBusy = isStartingUpgrade || upgradeInitiated || upgradeActive;
  const upgradeVisible = Boolean(hasUpgradeHint || upgradeStatus?.available || upgradeBusy);
  const progress = Math.round(upgradeInitiated && stage === 'ready' ? 0 : (upgradeStatus?.progress ?? 0));

  useEffect(() => {
    if (stage === 'complete' || stage === 'failed' || stage === 'ready') setInitialCheckPending(false);
    if (stage === 'failed') setUpgradeInitiated(false);
    setUpgradePolling(upgradeStatusIsActive(stage));
  }, [stage]);

  if (!upgradeVisible) return <ThemeToggle />;

  const stageLabel = upgradeStageLabel(t, stage);
  const label = upgradeBusy ? `${stageLabel} ${progress}%` : t('web.settings.system.updateTitle');

  const startUpgrade = async () => {
    if (upgradeBusy) return;
    setUpgradeInitiated(true);
    watchUpgradeRestartAndReload({
      baseUrl: daemonBaseUrl,
      currentVersion: daemonVersion,
      targetVersion: upgradeStatus?.latestVersion
    });
    try {
      await startSystemUpgrade().unwrap();
    } catch {
      setUpgradeInitiated(false);
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          className={cn(
            'rounded-full bg-accent-blue text-white hover:bg-accent-blue/90 hover:text-white',
            upgradeBusy ? 'h-[22px] min-w-10 px-2 font-medium text-[11px] tabular-nums' : 'h-7 w-7 px-0'
          )}
          disabled={upgradeBusy}
          onClick={() => void startUpgrade()}
          size="sm"
        >
          {upgradeBusy ? (
            `${progress}%`
          ) : (
            <HugeiconsIcon
              className="size-4"
              icon={Download04Icon}
            />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function upgradeStageLabel(t: ReturnType<typeof useT>, stage: SystemUpgradeStatus['stage'] | undefined): string {
  switch (stage) {
    case 'checking':
      return t('web.settings.system.upgradeStage.checking');
    case 'downloading':
      return t('web.settings.system.upgradeStage.downloading');
    case 'verifying':
      return t('web.settings.system.upgradeStage.verifying');
    case 'installing':
      return t('web.settings.system.upgradeStage.installing');
    case 'restarting':
      return t('web.settings.system.upgradeStage.restarting');
    default:
      return t('web.settings.system.upgradeStage.idle');
  }
}
