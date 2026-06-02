import { Confirm } from '@monad/ui';
import { useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { type DeleteProjectDialogState, deleteProjectDialogState } from './delete-project-dialog-model';

export interface DeleteProjectDialogProps {
  open: boolean;
  projectName: string;
  onOpenChange(open: boolean): void;
  onConfirm(): Promise<void>;
  onDeleted?(): void;
}

const initialState: DeleteProjectDialogState = { deleting: false, error: false };

export function DeleteProjectDialog(props: DeleteProjectDialogProps): React.ReactElement {
  const t = useT();
  const [state, setState] = useState<DeleteProjectDialogState>(initialState);

  const requestOpenChange = (open: boolean) => {
    if (open) {
      setState(initialState);
      props.onOpenChange(true);
      return;
    }
    const next = deleteProjectDialogState(state, 'dismiss');
    if (next.effect !== 'dismiss') return;
    setState(initialState);
    props.onOpenChange(false);
  };

  const confirm = async () => {
    const next = deleteProjectDialogState(state, 'confirm');
    if (next.effect !== 'confirm') return;
    setState({ deleting: next.deleting, error: next.error });
    try {
      await props.onConfirm();
    } catch {
      const failed = deleteProjectDialogState(next, 'failed');
      setState({ deleting: failed.deleting, error: failed.error });
      return;
    }
    setState(initialState);
    props.onOpenChange(false);
    props.onDeleted?.();
  };

  return (
    <Confirm
      cancelLabel={t('web.common.cancel')}
      confirmLabel={t('web.workplace.deleteProject')}
      confirmVariant="destructive"
      description={t('web.workplace.deleteProjectDialogDescription')}
      error={state.error ? t('web.workplace.deleteProjectDialogError') : undefined}
      onConfirm={() => void confirm()}
      onOpenChange={requestOpenChange}
      open={props.open}
      pending={state.deleting}
      pendingLabel={t('web.workplace.deletingProject')}
      title={t('web.workplace.deleteProjectDialogTitle', { name: props.projectName })}
    >
      <p className="text-muted-foreground text-sm">{t('web.workplace.deleteProjectDialogLocalFiles')}</p>
    </Confirm>
  );
}
