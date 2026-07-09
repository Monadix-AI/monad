'use client';

import { FolderOpenIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { usePickDirectoryMutation } from '@monad/client-rtk';
import { Button, Input, Label } from '@monad/ui';
import { useState } from 'react';

import { useT } from '#/components/I18nProvider';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '#/components/ui/dialog';

interface NewProjectDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (args: { name: string; cwd?: string }) => void;
}

export function NewProjectDialog({ open, onClose, onCreate }: NewProjectDialogProps) {
  const t = useT();
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const [pickDirectory, { isLoading: picking }] = usePickDirectoryMutation();

  const reset = () => {
    setName('');
    setCwd('');
  };

  const close = () => {
    reset();
    onClose();
  };

  const browse = async () => {
    const result = await pickDirectory({
      prompt: t('web.workplace.workdirLabel'),
      defaultPath: cwd || undefined
    }).unwrap();
    if (result.path) setCwd(result.path);
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('web.workplace.newProject')}</DialogTitle>
          <DialogDescription>{t('web.workplace.newProjectDescription')}</DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
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
            <Label htmlFor="new-project-cwd">
              {t('web.workplace.workdirLabel')}
              <span className="ml-1.5 font-normal text-muted-foreground text-xs">
                {t('web.workplace.workdirOptional')}
              </span>
            </Label>
            <div className="flex gap-2">
              <Input
                className="font-mono text-xs"
                id="new-project-cwd"
                onChange={(e) => setCwd(e.target.value)}
                placeholder={t('web.workplace.workdirPlaceholder')}
                value={cwd}
              />
              <Button
                className="shrink-0 gap-1.5"
                disabled={picking}
                onClick={browse}
                type="button"
                variant="outline"
              >
                <HugeiconsIcon
                  className="size-4"
                  icon={FolderOpenIcon}
                />
                {t('web.workplace.workdirBrowse')}
              </Button>
            </div>
          </div>

          <DialogFooter>
            <Button
              onClick={close}
              type="button"
              variant="ghost"
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
