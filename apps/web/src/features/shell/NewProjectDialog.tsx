import { PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { usePickDirectoryMutation } from '@monad/client-rtk';
import { Button, Input, Label } from '@monad/ui';
import { useState } from 'react';

import { useT } from '#/components/I18nProvider';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '#/components/ui/dialog';
import { ProjectCwdChip } from './ProjectCwdChip';

interface NewProjectDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (args: { name: string; cwd?: string }) => void;
}

export function NewProjectDialog({ open, onClose, onCreate }: NewProjectDialogProps) {
  const t = useT();
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const [pickerError, setPickerError] = useState(false);
  const [pickDirectory, { isLoading: picking }] = usePickDirectoryMutation();

  const reset = () => {
    setName('');
    setCwd('');
    setPickerError(false);
  };

  const close = () => {
    reset();
    onClose();
  };

  const browse = async () => {
    setPickerError(false);
    try {
      const result = await pickDirectory({
        prompt: t('web.workplace.workdirLabel'),
        defaultPath: cwd || undefined
      }).unwrap();
      if (result.path) setCwd(result.path);
    } catch {
      setPickerError(true);
    }
  };

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onCreate({ name: trimmed, cwd: cwd.trim() || undefined });
    reset();
  };

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) close();
      }}
      open={open}
    >
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t('web.workplace.newProject')}</DialogTitle>
          <DialogDescription>{t('web.workplace.newProjectDescription')}</DialogDescription>
        </DialogHeader>

        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <DialogBody className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-project-name">{t('web.workplace.projectNameLabel')}</Label>
              <Input
                autoFocus
                id="new-project-name"
                onChange={(e) => setName(e.target.value)}
                placeholder={t('web.workplace.projectNamePlaceholder')}
                value={name}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>
                {t('web.workplace.workdirLabel')}
                <span className="ml-1.5 font-normal text-muted-foreground text-xs">
                  {t('web.workplace.workdirOptional')}
                </span>
              </Label>
              {cwd ? (
                <ProjectCwdChip
                  disabled={picking}
                  onRemove={() => setCwd('')}
                  path={cwd}
                  removeLabel={t('web.workplace.workdirSettingsRemove')}
                />
              ) : (
                <button
                  aria-label={t('web.workplace.workdirSettingsAdd')}
                  className="inline-flex size-8 items-center justify-center rounded-full border border-border border-dashed bg-background text-muted-foreground outline-none transition-[background-color,border-color,color,box-shadow] hover:border-foreground/30 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"
                  disabled={picking}
                  onClick={() => void browse()}
                  title={t('web.workplace.workdirSettingsAdd')}
                  type="button"
                >
                  <HugeiconsIcon
                    className="size-4"
                    icon={PlusSignIcon}
                  />
                </button>
              )}
              {pickerError ? (
                <p
                  aria-live="polite"
                  className="m-0 text-destructive text-xs"
                >
                  {t('web.workplace.workdirPickerError')}
                </p>
              ) : null}
            </div>
          </DialogBody>

          <DialogFooter>
            <Button
              onClick={close}
              type="button"
              variant="outline"
            >
              {t('web.common.cancel')}
            </Button>
            <Button
              disabled={!name.trim()}
              type="submit"
            >
              {t('web.workplace.createProject')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
