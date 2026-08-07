import type { ChannelEnvVar, ChannelId, ChannelInstanceView, ChannelStatus } from '@monad/protocol';
import type { InstalledChannelOption } from './installed-channel-options';

import {
  Delete02Icon,
  ExternalLinkIcon,
  Key01Icon,
  LoaderPinwheelIcon,
  QrCodeIcon,
  Refresh01Icon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { newId } from '@monad/protocol';
import { Button, Confirm, cn, Input, Label, Textarea } from '@monad/ui';
import { useEffect, useState } from 'react';

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
import { SECRET_INPUT_PASSWORD_MANAGER_PROPS } from '#/lib/secret-input-props';
import { ChannelBrandIcon } from './ChannelBrandIcon';

function fieldsFor(adapter: InstalledChannelOption, t: ReturnType<typeof useT>): ChannelEnvVar[] {
  if (adapter.connectionMode === 'pairing') return [];
  if (adapter.envVars.length) return adapter.envVars;
  return [
    {
      name: 'TOKEN',
      description: t('web.ch.genericTokenHint'),
      required: true,
      secret: true,
      credentialKey: 'token'
    }
  ];
}

function inferredCredentialKey(name: string): string {
  const words = name.toLowerCase().split('_').filter(Boolean);
  return words.map((word, index) => (index === 0 ? word : `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`)).join('');
}

export function ChannelConnectionDialog({
  adapter,
  connection,
  onClose,
  onPair,
  onRemove,
  onSave,
  onSetCredential,
  statusById
}: {
  adapter: InstalledChannelOption;
  connection?: ChannelInstanceView;
  onClose: () => void;
  onPair: (id: ChannelId) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onSave: (connection: ChannelInstanceView) => Promise<void>;
  onSetCredential: (id: ChannelId, value: { token: string; extra?: Record<string, string> }) => Promise<void>;
  statusById: Map<string, ChannelStatus>;
}) {
  const t = useT();
  const pairing = adapter.connectionMode === 'pairing';
  const [savedConnection, setSavedConnection] = useState<ChannelInstanceView>();
  const effectiveConnection = savedConnection ?? connection;
  const editing = Boolean(effectiveConnection);
  const fields = fieldsFor(adapter, t);
  const [label, setLabel] = useState(connection?.label ?? adapter.label);
  const [requireMention, setRequireMention] = useState(connection?.groupPolicy?.requireMention ?? true);
  const [agentHint, setAgentHint] = useState(connection?.agentHint ?? '');
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [newConnectionId] = useState(() => newId('chn'));
  const connectionId = effectiveConnection?.id ?? newConnectionId;
  const status = statusById.get(connectionId);

  useEffect(() => {
    if (pairing && savedConnection && status?.phase === 'connected') onClose();
  }, [onClose, pairing, savedConnection, status?.phase]);

  const submit = async () => {
    const trimmedLabel = label.trim();
    if (!trimmedLabel) {
      setError(t('web.ch.labelRequired'));
      return;
    }

    const hasCredentialInput = fields.some((field) => Boolean(credentials[field.name]?.trim()));
    if (hasCredentialInput) {
      const missing = fields.find((field) => field.required && !credentials[field.name]?.trim());
      if (missing) {
        setError(t('web.ch.credentialRequired', { name: missing.name }));
        return;
      }
    }

    const id = connectionId;
    const next: ChannelInstanceView = {
      id,
      type: adapter.type,
      label: trimmedLabel,
      enabled: pairing ? true : (effectiveConnection?.enabled ?? false),
      groupPolicy: { requireMention },
      mapping: effectiveConnection?.mapping ?? { granularity: 'per-conversation' },
      agentHint: agentHint.trim() || undefined,
      credentialConfigured: effectiveConnection?.credentialConfigured ?? false,
      rateLimitPerMin: effectiveConnection?.rateLimitPerMin ?? 20
    };

    setBusy(true);
    setError(undefined);
    try {
      await onSave(next);
      if (hasCredentialInput) {
        const values = fields.flatMap((field) => {
          const value = credentials[field.name]?.trim();
          if (!value) return [];
          return [[field.credentialKey ?? inferredCredentialKey(field.name), value] as const];
        });
        const token = values.find(([key]) => key === 'token')?.[1] ?? `channel:${adapter.type}`;
        await onSetCredential(id, {
          token,
          extra: Object.fromEntries(values.filter(([key]) => key !== 'token'))
        });
      }
      if (pairing) setSavedConnection(next);
      else onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : t('web.ch.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open
    >
      <DialogContent size="lg">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <ChannelBrandIcon icon={adapter.icon} />
            <div className="min-w-0">
              <DialogTitle>{editing ? t('web.ch.editConnectionTitle') : t('web.ch.addConnectionTitle')}</DialogTitle>
              <DialogDescription>{adapter.label}</DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <DialogBody className="grid max-h-[min(65dvh,44rem)] gap-5 overflow-y-auto">
          {adapter.setup ? (
            <section className="grid gap-3 rounded-lg border bg-muted/30 p-4">
              <div className="grid gap-1">
                <h3 className="font-medium text-sm">{t('web.ch.howToConnect')}</h3>
                <p className="text-muted-foreground text-xs leading-relaxed">{adapter.setup.summary}</p>
              </div>
              <ol className="grid list-decimal gap-1.5 pl-4 text-sm">
                {adapter.setup.steps.map((step) => (
                  <li
                    className="pl-1"
                    key={step}
                  >
                    {step}
                  </li>
                ))}
              </ol>
              {adapter.setup.docsUrl ? (
                <a
                  className="inline-flex w-fit items-center gap-1.5 font-medium text-primary text-xs hover:underline"
                  href={adapter.setup.docsUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  {t('web.ch.openSetupGuide')}
                  <HugeiconsIcon
                    className="size-3.5"
                    icon={ExternalLinkIcon}
                  />
                </a>
              ) : null}
            </section>
          ) : null}
          {pairing && effectiveConnection ? (
            <section className="grid justify-items-center gap-3 rounded-lg border bg-muted/30 p-4 text-center">
              <div className="flex items-center gap-2 font-medium text-sm">
                <HugeiconsIcon icon={QrCodeIcon} />
                {status?.phase === 'connected' ? t('web.ch.whatsappConnected') : t('web.ch.scanWhatsappQr')}
              </div>
              {status?.pairingQr ? (
                // biome-ignore lint/performance/noImgElement: the transient QR is a daemon-provided data URL.
                <img
                  alt={t('web.ch.whatsappQrAlt')}
                  className="size-64 rounded-lg bg-white p-2"
                  height={256}
                  src={status.pairingQr}
                  width={256}
                />
              ) : status?.phase === 'connected' ? (
                <p className="text-green-600 text-sm dark:text-green-400">{t('web.ch.whatsappLinked')}</p>
              ) : (
                <p className="text-muted-foreground text-sm">{status?.lastError ?? t('web.ch.waitingForWhatsappQr')}</p>
              )}
              <Button
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError(undefined);
                  void onPair(connectionId)
                    .catch((pairError) => {
                      setError(pairError instanceof Error ? pairError.message : t('web.ch.pairFailed'));
                    })
                    .finally(() => setBusy(false));
                }}
                size="sm"
                variant="outline"
              >
                <HugeiconsIcon
                  className={busy ? 'animate-spin' : undefined}
                  icon={busy ? LoaderPinwheelIcon : Refresh01Icon}
                />
                {t('web.ch.pairAgain')}
              </Button>
            </section>
          ) : null}
          <section className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="channel-connection-label">{t('web.ch.label')}</Label>
              <Input
                id="channel-connection-label"
                name="channel-connection-label"
                onChange={(event) => setLabel(event.target.value)}
                value={label}
              />
            </div>
          </section>

          {!pairing ? (
            <section className="grid gap-2">
              <div>
                <h3 className="font-medium text-sm">{t('web.ch.credentials')}</h3>
                {editing ? <p className="text-muted-foreground text-xs">{t('web.ch.credentialsReplaceHint')}</p> : null}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {fields.map((field) => (
                  <div
                    className="grid min-w-0 gap-1.5"
                    key={field.name}
                  >
                    <Label htmlFor={`channel-credential-${field.name}`}>
                      {field.name}
                      {!field.required ? ` ${t('web.ch.optional')}` : ''}
                    </Label>
                    <Input
                      className={cn('min-w-0', field.secret && '[-webkit-text-security:disc]')}
                      id={`channel-credential-${field.name}`}
                      name={field.name}
                      onChange={(event) =>
                        setCredentials((current) => ({ ...current, [field.name]: event.target.value }))
                      }
                      placeholder={field.description || t('web.ch.tokenPlaceholder')}
                      value={credentials[field.name] ?? ''}
                      {...(field.secret ? SECRET_INPUT_PASSWORD_MANAGER_PROPS : {})}
                    />
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <section className="grid gap-3">
            {adapter.capabilities?.groupMentionPolicy ? (
              <label className="flex items-center gap-2 text-muted-foreground text-xs">
                <input
                  checked={requireMention}
                  onChange={(event) => setRequireMention(event.target.checked)}
                  type="checkbox"
                />
                {t('web.ch.requireMention')}
              </label>
            ) : null}
            <div className="grid gap-1.5">
              <Label htmlFor="channel-connection-hint">{t('web.ch.agentHint')}</Label>
              <Textarea
                id="channel-connection-hint"
                name="channel-connection-hint"
                onChange={(event) => setAgentHint(event.target.value)}
                placeholder={t('web.ch.agentHintPlaceholder')}
                rows={2}
                value={agentHint}
              />
            </div>
          </section>

          {error ? <p className="text-destructive text-sm">{error}</p> : null}
        </DialogBody>
        <DialogFooter className="justify-between sm:justify-between">
          <div>
            {effectiveConnection ? (
              <Button
                disabled={busy}
                onClick={() => setConfirmRemove(true)}
                variant="ghost"
              >
                <HugeiconsIcon icon={Delete02Icon} />
                {t('web.ch.removeConnection')}
              </Button>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button
              disabled={busy}
              onClick={onClose}
              variant="outline"
            >
              {pairing && savedConnection ? t('web.common.close') : t('web.common.cancel')}
            </Button>
            {!pairing || !savedConnection ? (
              <Button
                disabled={busy}
                onClick={() => void submit()}
              >
                <HugeiconsIcon
                  className={busy ? 'animate-spin' : undefined}
                  icon={busy ? LoaderPinwheelIcon : pairing ? QrCodeIcon : Key01Icon}
                />
                {busy ? t('web.common.saving') : pairing && !connection ? t('web.ch.saveAndPair') : t('web.save')}
              </Button>
            ) : null}
          </div>
        </DialogFooter>
      </DialogContent>
      <Confirm
        cancelLabel={t('web.common.cancel')}
        confirmLabel={t('web.ch.removeConnection')}
        confirmVariant="destructive"
        description={t('web.ch.confirmRemoveDescription', { name: effectiveConnection?.label ?? '' })}
        onConfirm={() => {
          if (!effectiveConnection) return;
          setBusy(true);
          void onRemove(effectiveConnection.id)
            .then(() => {
              setConfirmRemove(false);
              onClose();
            })
            .catch((removeError) => {
              setError(removeError instanceof Error ? removeError.message : t('web.ch.removeFailed'));
            })
            .finally(() => setBusy(false));
        }}
        onOpenChange={setConfirmRemove}
        open={confirmRemove}
        pending={busy}
        pendingLabel={t('web.ch.removing')}
        title={t('web.ch.confirmRemove')}
      />
    </Dialog>
  );
}
