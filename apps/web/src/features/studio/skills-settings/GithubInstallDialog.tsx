import { Alert01Icon, ExternalLinkIcon, LoaderPinwheelIcon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useInstallSkillMutation } from '@monad/client-rtk';
import { Button, Input } from '@monad/ui';
import { useEffect, useRef, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { MonadIcon } from '#/components/MonadLogo';
import { toast } from '#/components/ToastProvider';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '#/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '#/components/ui/popover';
import { ConsentPopover } from './ConsentPopover';
import { GitHubMark } from './GitHubMark';
import { normalizeGithubSkillSource } from './utils';

export function GithubInstallDialog({
  onCancel,
  onInstalled
}: {
  onCancel: () => void;
  onInstalled: () => Promise<void> | void;
}) {
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      open
    >
      <DialogContent className="max-w-xl">
        <InstallForm
          onCancel={onCancel}
          onInstalled={onInstalled}
        />
      </DialogContent>
    </Dialog>
  );
}

function InstallForm({ onInstalled }: { onCancel: () => void; onInstalled: () => Promise<void> | void }) {
  const t = useT();
  const [install, { isLoading }] = useInstallSkillMutation();
  const [source, setSource] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [consent, setConsent] = useState<{ skills: string[]; warnings: string[] } | null>(null);
  const mountedRef = useRef(true);
  const consentToastIdRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const submit = async (withConsent: boolean) => {
    const src = source.trim();
    if (!src) return;
    setError(null);
    const normalized = normalizeGithubSkillSource(src);
    if (!normalized) {
      setError(t('web.skills.githubInvalidUrl'));
      return;
    }
    const res = await install({ source: normalized, consent: withConsent })
      .unwrap()
      .catch(() => null);
    if (!res) {
      toast.error(t('web.skills.installFailed'));
      return;
    }
    if (res.needsConsent) {
      const consentInfo = { skills: res.skills, warnings: res.warnings };
      setConsent(consentInfo);
      consentToastIdRef.current = toast.info(t('web.skills.consentToast'), {
        action: {
          label: t('web.skills.consentConfirm'),
          onClick: async () => {
            const confirmed = await install({ source: normalized, consent: true })
              .unwrap()
              .catch(() => null);
            if (!confirmed || confirmed.needsConsent) {
              toast.error(t('web.skills.installFailed'));
              return false;
            }
            toast.success(t('web.skills.installSucceeded'));
            consentToastIdRef.current = null;
            if (!mountedRef.current) return;
            setConsent(null);
            await onInstalled();
          }
        },
        detail: consentInfo,
        duration: Number.POSITIVE_INFINITY
      });
      return;
    }
    if (consentToastIdRef.current) toast.dismiss(consentToastIdRef.current);
    consentToastIdRef.current = null;
    await onInstalled();
  };

  return (
    <div className="flex flex-col gap-5">
      <DialogHeader className="items-center text-center">
        <div className="flex items-center gap-4 py-1">
          <div className="grid size-12 place-items-center rounded-xl border bg-background shadow-sm">
            <GitHubMark className="size-6" />
          </div>
          <span className="text-muted-foreground">↔</span>
          <div className="grid size-12 place-items-center rounded-xl border bg-background shadow-sm">
            <MonadIcon className="size-8" />
          </div>
        </div>
        <DialogTitle className="text-2xl">{t('web.skills.githubTitle')}</DialogTitle>
        <DialogDescription className="text-base">{t('web.skills.githubHint')}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-2">
        <Popover open={!!error}>
          <PopoverTrigger asChild>
            <div className="relative">
              <Input
                className="h-12 pr-12 text-base"
                onChange={(e) => {
                  setSource(e.target.value);
                  setError(null);
                  setConsent(null);
                  if (consentToastIdRef.current) toast.dismiss(consentToastIdRef.current);
                  consentToastIdRef.current = null;
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void submit(false);
                  }
                }}
                placeholder={t('web.skills.githubPlaceholder')}
                value={source}
              />
              <Button
                aria-label={t('web.skills.install')}
                className="absolute top-1.5 right-1.5 size-9"
                disabled={isLoading || !source.trim()}
                onClick={() => void submit(false)}
                size="icon"
                variant="ghost"
              >
                <HugeiconsIcon
                  className="size-4"
                  icon={ExternalLinkIcon}
                />
              </Button>
            </div>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-auto max-w-72 border-destructive/40 bg-destructive/8 px-3 py-2 text-destructive"
            onOpenAutoFocus={(e) => e.preventDefault()}
            side="bottom"
          >
            <p className="flex items-center gap-1.5 text-sm">
              <HugeiconsIcon
                className="size-3.5 shrink-0"
                icon={Alert01Icon}
              />
              {error}
            </p>
          </PopoverContent>
        </Popover>
      </div>

      <ConsentPopover
        consent={consent}
        id="github-install"
        installingId={isLoading ? 'github-install' : null}
        onCancel={() => setConsent(null)}
        onConfirm={() => submit(true)}
      >
        <Button
          className="h-12 text-base"
          disabled={isLoading || !source.trim()}
          onClick={() => void submit(false)}
        >
          {isLoading ? (
            <HugeiconsIcon
              className="size-3.5 animate-spin"
              icon={LoaderPinwheelIcon}
            />
          ) : (
            <HugeiconsIcon icon={PlusSignIcon} />
          )}
          {isLoading ? t('web.skills.installing') : consent ? t('web.skills.consentReview') : t('web.skills.install')}
        </Button>
      </ConsentPopover>
    </div>
  );
}
