import type { RefObject } from 'react';

import { FileArchiveIcon, LoaderPinwheelIcon, TextIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';

import { useT } from '#/components/I18nProvider';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '#/components/ui/dialog';

export function UploadSkillDialog({
  inputRef,
  loading,
  onClose,
  onFile,
  open
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  loading: boolean;
  onClose: () => void;
  onFile: (file: File | undefined) => void;
  open: boolean;
}) {
  const t = useT();
  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      open={open}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-2xl">{t('web.skills.uploadTitle')}</DialogTitle>
        </DialogHeader>
        <button
          className="flex min-h-48 flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed bg-muted/20 px-6 py-10 text-center transition hover:bg-muted/35"
          disabled={loading}
          onClick={() => inputRef.current?.click()}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            onFile(event.dataTransfer.files?.[0]);
          }}
          type="button"
        >
          <div className="flex items-center text-muted-foreground/50 [&>*+*]:-ml-2">
            <HugeiconsIcon
              className="size-10 rotate-[-8deg] rounded-md bg-background/70 p-2"
              icon={TextIcon}
            />
            <HugeiconsIcon
              className="z-1 size-12 rounded-md bg-background/90 p-2.5"
              icon={TextIcon}
            />
            <HugeiconsIcon
              className="size-10 rotate-[8deg] rounded-md bg-background/70 p-2"
              icon={FileArchiveIcon}
            />
          </div>
          <span className="font-medium text-lg text-muted-foreground">{t('web.skills.uploadDrop')}</span>
          {loading ? (
            <HugeiconsIcon
              className="size-4 animate-spin text-foreground"
              icon={LoaderPinwheelIcon}
            />
          ) : null}
        </button>
        <div className="flex flex-col gap-2 text-sm">
          <h3 className="font-medium">{t('web.skills.fileRequirements')}</h3>
          <ul className="ml-5 flex list-disc flex-col gap-1 text-muted-foreground">
            <li>{t('web.skills.fileRequirementArchive')}</li>
            <li>{t('web.skills.fileRequirementFrontmatter')}</li>
          </ul>
        </div>
        <p className="text-muted-foreground text-sm">{t('web.skills.createSkillHelp')}</p>
      </DialogContent>
    </Dialog>
  );
}
