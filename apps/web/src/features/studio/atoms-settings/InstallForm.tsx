import { Alert01Icon, Cancel01Icon, LoaderPinwheelIcon, PackageIcon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useInstallAtomPackMutation, useUploadAtomPackMutation } from '@monad/client-rtk';
import { Badge, Button, Input, Label } from '@monad/ui';
import { useState } from 'react';

import { useT } from '#/components/I18nProvider';

export function InstallForm({ onCancel, onInstalled }: { onCancel: () => void; onInstalled: () => void }) {
  const t = useT();
  const [install, { isLoading: installingSource }] = useInstallAtomPackMutation();
  const [upload, { isLoading: uploadingPack }] = useUploadAtomPackMutation();
  const [source, setSource] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [consent, setConsent] = useState<{ atoms: string[]; warnings: string[]; mode: 'source' | 'upload' } | null>(
    null
  );
  const isLoading = installingSource || uploadingPack;

  const handleResult = (
    res: { needsConsent?: boolean; atoms: string[]; warnings: string[] } | null,
    mode: 'source' | 'upload'
  ) => {
    if (!res) {
      setError(t('web.atoms.installFailed'));
      return;
    }
    if (res.needsConsent) {
      setConsent({ atoms: res.atoms, warnings: res.warnings, mode });
      return;
    }
    onInstalled();
  };

  const submitSource = async (withConsent: boolean) => {
    const src = source.trim();
    if (!src) return;
    setError(null);
    const res = await install({ source: src, consent: withConsent })
      .unwrap()
      .catch(() => null);
    handleResult(res, 'source');
  };

  const submitUpload = async (withConsent: boolean) => {
    if (!file) return;
    setError(null);
    const res = await upload({
      filename: file.name,
      body: file,
      contentType: file.type || 'application/zip',
      consent: withConsent
    })
      .unwrap()
      .catch(() => null);
    handleResult(res, 'upload');
  };

  return (
    <div className="flex flex-col gap-3 rounded-md border border-primary/30 bg-primary/5 p-3">
      <div className="flex items-center justify-between">
        <span className="font-medium text-sm">{t('web.atoms.addTitle')}</span>
        <Button
          className="size-6"
          onClick={onCancel}
          size="icon"
          variant="ghost"
        >
          <HugeiconsIcon icon={Cancel01Icon} />
        </Button>
      </div>
      <div className="flex flex-col gap-1">
        <Label className="text-xs">{t('web.atoms.source')}</Label>
        <Input
          onChange={(e) => {
            setSource(e.target.value);
            setConsent(null);
          }}
          placeholder={t('web.atoms.sourcePlaceholder')}
          value={source}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          className="gap-1.5"
          onClick={() => {
            setSource('debug:monad-power-pack');
            setConsent(null);
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          <HugeiconsIcon
            className="size-3.5"
            icon={PackageIcon}
          />
          {t('web.atoms.debugPowerPack')}
        </Button>
        <Input
          accept=".zip,application/zip"
          className="max-w-64 text-xs"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setConsent(null);
          }}
          type="file"
        />
        <Button
          className="gap-1.5"
          disabled={isLoading || !file}
          onClick={() => void submitUpload(false)}
          size="sm"
          type="button"
          variant="outline"
        >
          {uploadingPack ? (
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
          {t('web.atoms.uploadZip')}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">{t('web.atoms.addHint')}</p>

      {consent ? (
        <div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs">
          <span className="font-medium text-warning">{t('web.atoms.consentTitle')}</span>
          <div className="flex flex-wrap gap-1.5">
            {consent.atoms.map((a) => (
              <Badge
                className="text-[10px]"
                key={a}
                variant="outline"
              >
                {a}
              </Badge>
            ))}
          </div>
          {consent.warnings.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="flex items-center gap-1 font-medium text-warning">
                <HugeiconsIcon
                  className="size-3"
                  icon={Alert01Icon}
                />
                {t('web.atoms.warningsTitle')}
              </span>
              {consent.warnings.map((w) => (
                <span
                  className="text-muted-foreground"
                  key={w}
                >
                  {w}
                </span>
              ))}
            </div>
          )}
          <Button
            className="self-start"
            disabled={isLoading}
            onClick={() => void (consent.mode === 'upload' ? submitUpload(true) : submitSource(true))}
            size="sm"
          >
            {isLoading ? (
              <HugeiconsIcon
                className="size-3.5 animate-spin"
                icon={LoaderPinwheelIcon}
              />
            ) : null}
            {t('web.atoms.consentConfirm')}
          </Button>
        </div>
      ) : (
        <Button
          className="self-start"
          disabled={isLoading || !source.trim()}
          onClick={() => void submitSource(false)}
          size="sm"
        >
          {isLoading ? (
            <HugeiconsIcon
              className="size-3.5 animate-spin"
              icon={LoaderPinwheelIcon}
            />
          ) : (
            <HugeiconsIcon icon={PlusSignIcon} />
          )}
          {isLoading ? t('web.atoms.installing') : t('web.atoms.install')}
        </Button>
      )}

      {error ? <p className="text-destructive text-xs">{error}</p> : null}
    </div>
  );
}
