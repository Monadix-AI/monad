import type { AtomPackUpdateCheck } from '@monad/protocol';

import { Confirm } from '@monad/ui';
import { useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { type AtomPackUpdateDialogState, atomPackUpdateDialogState } from './atom-pack-update-dialog-model';

export interface AtomPackUpdateDialogProps {
  open: boolean;
  packName: string;
  update: AtomPackUpdateCheck;
  onOpenChange(open: boolean): void;
  onConfirm(): Promise<void>;
}

const initialState: AtomPackUpdateDialogState = { updating: false, error: false };

export function AtomPackUpdateDialog(props: AtomPackUpdateDialogProps): React.ReactElement {
  const t = useT();
  const [state, setState] = useState<AtomPackUpdateDialogState>(initialState);

  const requestOpenChange = (open: boolean) => {
    if (open) {
      setState(initialState);
      props.onOpenChange(true);
      return;
    }
    const next = atomPackUpdateDialogState(state, 'dismiss');
    if (next.effect !== 'dismiss') return;
    setState(initialState);
    props.onOpenChange(false);
  };

  const confirm = async () => {
    const next = atomPackUpdateDialogState(state, 'confirm');
    if (next.effect !== 'confirm') return;
    setState({ updating: next.updating, error: next.error });
    try {
      await props.onConfirm();
    } catch {
      const failed = atomPackUpdateDialogState(next, 'failed');
      setState({ updating: failed.updating, error: failed.error });
      return;
    }
    const succeeded = atomPackUpdateDialogState(next, 'succeeded');
    setState(initialState);
    if (succeeded.effect === 'dismiss') props.onOpenChange(false);
  };

  return (
    <Confirm
      cancelLabel={t('web.common.cancel')}
      confirmDisabled={!props.update.hasUpdate}
      confirmLabel={t('web.atoms.confirmUpdate')}
      description={t(props.update.hasUpdate ? 'web.atoms.updateDescription' : 'web.atoms.noUpdate')}
      error={state.error ? t('web.atoms.updateFailed') : undefined}
      onConfirm={() => void confirm()}
      onOpenChange={requestOpenChange}
      open={props.open}
      pending={state.updating}
      pendingLabel={t('web.atoms.updating')}
      title={t('web.atoms.updateTitle', { name: props.packName })}
    >
      <div className="min-w-0 rounded-md border bg-muted/40 p-3">
        <p className="mb-1 text-muted-foreground text-xs">{t('web.atoms.updateSource')}</p>
        <p className="break-all font-ui text-xs">{props.update.source}</p>
        <p className="mt-2 text-muted-foreground text-xs">
          {t('web.atoms.updateVersions', {
            current: props.update.currentVersion,
            latest: props.update.latestVersion
          })}
        </p>
      </div>
    </Confirm>
  );
}
