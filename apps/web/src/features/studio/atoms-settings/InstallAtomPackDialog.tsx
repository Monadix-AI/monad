import { Alert01Icon, FolderOpenIcon, LoaderPinwheelIcon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useInstallAtomPackMutation, usePickDirectoryMutation } from '@monad/client-rtk';
import { Badge, Button, Input, Label } from '@monad/ui';
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

type SourceKind = 'github' | 'local';
type ConsentRequest = { atoms: string[]; warnings: string[] };

export function InstallAtomPackDialog({ onOpenChange, open }: { onOpenChange(open: boolean): void; open: boolean }) {
  const t = useT();
  const [install, { isLoading }] = useInstallAtomPackMutation();
  const [pickDirectory, { isLoading: isPickingDirectory }] = usePickDirectoryMutation();
  const [sourceKind, setSourceKind] = useState<SourceKind>('github');
  const [source, setSource] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [consent, setConsent] = useState<ConsentRequest | null>(null);

  const reset = () => {
    setSource('');
    setSourceKind('github');
    setError(null);
    setConsent(null);
  };

  const close = () => {
    if (isLoading) return;
    reset();
    onOpenChange(false);
  };

  const handleResult = (res: { needsConsent?: boolean; atoms: string[]; warnings: string[] } | null) => {
    if (!res) {
      setError(t('web.atoms.installFailed'));
      return;
    }
    if (res.needsConsent) {
      setConsent({ atoms: res.atoms, warnings: res.warnings });
      return;
    }
    reset();
    onOpenChange(false);
  };

  const submitSource = async (withConsent: boolean) => {
    const input = source.trim();
    if (!input) return;
    const src = sourceKind === 'local' && !input.startsWith('local:') ? `local:${input}` : input;
    setError(null);
    const res = await install({ source: src, consent: withConsent })
      .unwrap()
      .catch(() => null);
    handleResult(res);
  };

  const chooseLocalDirectory = async (defaultPath = source) => {
    setError(null);
    setConsent(null);
    const result = await pickDirectory({
      prompt: t('web.atoms.localChoose'),
      defaultPath: defaultPath || undefined
    })
      .unwrap()
      .catch(() => null);
    if (!result) {
      setError(t('web.atoms.localPickerError'));
      return;
    }
    if (result.path) setSource(result.path);
  };

  const submitPrimary = () => submitSource(Boolean(consent));

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) close();
      }}
      open={open}
    >
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{t('web.atoms.addTitle')}</DialogTitle>
          <DialogDescription>{t('web.atoms.addHint')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void submitPrimary();
            }}
          >
            <div className="flex gap-2">
              {(['github', 'local'] as const).map((kind) => (
                <Button
                  key={kind}
                  onClick={() => {
                    setSourceKind(kind);
                    setSource('');
                    setConsent(null);
                    setError(null);
                    if (kind === 'local') void chooseLocalDirectory('');
                  }}
                  size="sm"
                  type="button"
                  variant={sourceKind === kind ? 'secondary' : 'outline'}
                >
                  {t(kind === 'github' ? 'web.atoms.githubRepo' : 'web.atoms.localDev')}
                </Button>
              ))}
            </div>
            <Label htmlFor="atom-pack-source">{t('web.atoms.source')}</Label>
            {sourceKind === 'github' ? (
              <Input
                autoFocus
                disabled={isLoading}
                id="atom-pack-source"
                name="atom-pack-source"
                onChange={(event) => {
                  setSource(event.target.value);
                  setConsent(null);
                }}
                placeholder={t('web.atoms.githubPlaceholder')}
                spellCheck={false}
                value={source}
              />
            ) : (
              <div className="flex gap-2">
                <Input
                  disabled
                  id="atom-pack-source"
                  name="atom-pack-source"
                  placeholder={t('web.atoms.localPlaceholder')}
                  value={source}
                />
                <Button
                  disabled={isLoading || isPickingDirectory}
                  onClick={() => void chooseLocalDirectory()}
                  type="button"
                  variant="outline"
                >
                  <HugeiconsIcon
                    className={isPickingDirectory ? 'size-3.5 animate-spin' : 'size-3.5'}
                    icon={isPickingDirectory ? LoaderPinwheelIcon : FolderOpenIcon}
                  />
                  {isPickingDirectory ? t('web.atoms.localChoosing') : t('web.atoms.localChoose')}
                </Button>
              </div>
            )}
          </form>

          {consent ? (
            <div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
              <span className="font-medium text-warning">{t('web.atoms.consentTitle')}</span>
              <div className="flex flex-wrap gap-1.5">
                {consent.atoms.map((atom) => (
                  <Badge
                    className="text-[10px]"
                    key={atom}
                    variant="outline"
                  >
                    {atom}
                  </Badge>
                ))}
              </div>
              {consent.warnings.length > 0 ? (
                <div className="flex flex-col gap-1">
                  <span className="flex items-center gap-1 font-medium text-warning">
                    <HugeiconsIcon
                      className="size-3"
                      icon={Alert01Icon}
                    />
                    {t('web.atoms.warningsTitle')}
                  </span>
                  {consent.warnings.map((warning) => (
                    <span
                      className="break-words text-muted-foreground"
                      key={warning}
                    >
                      {warning}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {error ? (
            <p
              aria-live="polite"
              className="text-destructive text-xs"
            >
              {error}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button
            disabled={isLoading || isPickingDirectory}
            onClick={close}
            type="button"
            variant="outline"
          >
            {t('web.common.cancel')}
          </Button>
          <Button
            disabled={isLoading || isPickingDirectory || (!consent && !source.trim())}
            onClick={() => void submitPrimary()}
            type="button"
          >
            {isLoading ? (
              <HugeiconsIcon
                className="size-3.5 animate-spin"
                icon={LoaderPinwheelIcon}
              />
            ) : (
              <HugeiconsIcon
                className="size-3.5"
                icon={PlusSignIcon}
              />
            )}
            {isLoading ? t('web.atoms.installing') : consent ? t('web.atoms.consentConfirm') : t('web.atoms.install')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
