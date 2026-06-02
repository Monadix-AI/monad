import type { SkillAddTarget, SkillInstallResult } from './types';

import { Alert01Icon, ExternalLinkIcon, LoaderPinwheelIcon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useInstallSkillMutation } from '@monad/client-rtk';
import { Button, Input } from '@monad/ui';
import { useEffect, useRef, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { MonadIcon } from '#/components/MonadLogo';
import { toast } from '#/components/ToastProvider';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '#/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '#/components/ui/popover';
import { ConsentPopover } from './ConsentPopover';
import { GitHubMark } from './GitHubMark';
import { skillMutationTarget } from './types';
import { normalizeGithubSkillSource } from './utils';

export function GithubInstallDialog({
  onCancel,
  onInstalled,
  target = { kind: 'workspace' }
}: {
  onCancel: () => void;
  onInstalled: (result: SkillInstallResult) => Promise<void> | void;
  target?: SkillAddTarget;
}) {
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      open
    >
      <DialogContent size="lg">
        <InstallForm
          onCancel={onCancel}
          onInstalled={onInstalled}
          target={target}
        />
      </DialogContent>
    </Dialog>
  );
}

function InstallForm({
  onCancel,
  onInstalled,
  target
}: {
  onCancel: () => void;
  onInstalled: (result: SkillInstallResult) => Promise<void> | void;
  target: SkillAddTarget;
}) {
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
    const res = await install({ source: normalized, consent: withConsent, target: skillMutationTarget(target) })
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
            const confirmed = await install({ source: normalized, consent: true, target: skillMutationTarget(target) })
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
            await onInstalled({ ids: confirmed.skillIds ?? [], names: confirmed.skills });
          }
        },
        detail: consentInfo,
        duration: Number.POSITIVE_INFINITY
      });
      return;
    }
    if (consentToastIdRef.current) toast.dismiss(consentToastIdRef.current);
    consentToastIdRef.current = null;
    await onInstalled({ ids: res.skillIds ?? [], names: res.skills });
  };

  return (
    <>
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
      <DialogBody className="flex flex-col gap-3 pt-1">
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
              <HugeiconsIcon
                aria-hidden
                className="absolute top-1/2 right-4 size-4 -translate-y-1/2 text-muted-foreground"
                icon={ExternalLinkIcon}
              />
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
      </DialogBody>

      <DialogFooter>
        <Button
          onClick={onCancel}
          variant="outline"
        >
          {t('web.common.cancel')}
        </Button>
        <ConsentPopover
          consent={consent}
          id="github-install"
          installingId={isLoading ? 'github-install' : null}
          onCancel={() => setConsent(null)}
          onConfirm={() => submit(true)}
        >
          <Button
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
      </DialogFooter>
    </>
  );
}
