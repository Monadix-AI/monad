import type { CodeExecBackend, EmailBackend, WebSearchProvider } from './tool-backends-request';

import {
  CheckIcon,
  Delete02Icon,
  FileCodeIcon,
  GlobeIcon,
  LoaderPinwheelIcon,
  Mail01Icon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button, Input, Label } from '@monad/ui';

import { useT } from '#/components/I18nProvider';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '#/components/ui/dialog';

type SaveDialogProps = {
  saving: boolean;
  saveError?: string;
  onSave: () => void;
  onCancel: () => void;
};

function SaveDialogActions({ saving, onSave, onCancel }: Omit<SaveDialogProps, 'saveError'>) {
  const t = useT();

  return (
    <DialogFooter>
      <Button
        onClick={onCancel}
        size="sm"
        variant="outline"
      >
        {t('web.model.cancel')}
      </Button>
      <Button
        disabled={saving}
        onClick={onSave}
        size="sm"
      >
        {saving ? (
          <HugeiconsIcon
            className="animate-spin"
            icon={LoaderPinwheelIcon}
          />
        ) : (
          <HugeiconsIcon icon={CheckIcon} />
        )}
        {saving ? t('web.common.saving') : t('web.common.save')}
      </Button>
    </DialogFooter>
  );
}

export function CredentialActionsView({
  configured,
  value,
  pendingRemoval,
  onRemove,
  removeLabel,
  pendingLabel
}: {
  configured: boolean;
  value: string;
  pendingRemoval: boolean;
  onRemove: () => void;
  removeLabel: string;
  pendingLabel: string;
}) {
  if (pendingRemoval) {
    return <p className="text-destructive text-xs">{pendingLabel}</p>;
  }
  if (!configured && !value) return null;

  return (
    <Button
      className="self-start"
      onClick={onRemove}
      size="sm"
      type="button"
      variant="outline"
    >
      <HugeiconsIcon icon={Delete02Icon} />
      {removeLabel}
    </Button>
  );
}

function CredentialActions(props: Omit<Parameters<typeof CredentialActionsView>[0], 'removeLabel' | 'pendingLabel'>) {
  const t = useT();

  return (
    <CredentialActionsView
      {...props}
      pendingLabel={t('web.tools.credentialRemovalPending')}
      removeLabel={t('web.tools.removeCredential')}
    />
  );
}

export function WebSearchSettingsDialog({
  open,
  wsProvider,
  braveApiKey,
  braveApiKeyConfigured,
  braveApiKeyRemovalPending,
  saving,
  saveError,
  setWsProvider,
  setBraveApiKey,
  onRemoveBraveApiKey,
  onSave,
  onCancel
}: SaveDialogProps & {
  open: boolean;
  wsProvider: WebSearchProvider;
  braveApiKey: string;
  braveApiKeyConfigured: boolean;
  braveApiKeyRemovalPending: boolean;
  setWsProvider: (provider: WebSearchProvider) => void;
  setBraveApiKey: (key: string) => void;
  onRemoveBraveApiKey: () => void;
}) {
  const t = useT();

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onCancel();
      }}
      open={open}
    >
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HugeiconsIcon
              className="size-4"
              icon={GlobeIcon}
            />{' '}
            {t('web.tools.searchTool')}
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>{t('web.tools.searchProviderLabel')}</Label>
            <div className="flex flex-wrap gap-2">
              {(['auto', 'native', 'ddgs', 'brave'] as const).map((provider) => (
                <button
                  className={`rounded-md border px-3 py-1.5 text-sm ${wsProvider === provider ? 'border-ring bg-primary-subtle text-primary' : ''}`}
                  key={provider}
                  onClick={() => setWsProvider(provider)}
                  type="button"
                >
                  {provider === 'auto'
                    ? t('web.tools.searchProviderAuto')
                    : provider === 'native'
                      ? t('web.tools.searchProviderNative')
                      : provider === 'ddgs'
                        ? 'DuckDuckGo'
                        : 'Brave'}
                </button>
              ))}
            </div>
            <p className="text-muted-foreground text-xs">
              {wsProvider === 'native'
                ? t('web.tools.wsNative')
                : wsProvider === 'brave'
                  ? t('web.tools.wsBrave')
                  : wsProvider === 'ddgs'
                    ? t('web.tools.wsDdgs')
                    : t('web.tools.wsAuto')}
            </p>
          </div>
          {wsProvider === 'brave' && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="brave-api-key">{t('web.tools.braveApiKey')}</Label>
              <Input
                id="brave-api-key"
                onChange={(e) => setBraveApiKey(e.target.value)}
                placeholder={t('web.tools.credentialWriteOnlyPlaceholder')}
                value={braveApiKey}
              />
              <CredentialActions
                configured={braveApiKeyConfigured}
                onRemove={onRemoveBraveApiKey}
                pendingRemoval={braveApiKeyRemovalPending}
                value={braveApiKey}
              />
            </div>
          )}
          {saveError ? <p className="text-destructive text-xs">{saveError}</p> : null}
        </DialogBody>
        <SaveDialogActions
          onCancel={onCancel}
          onSave={onSave}
          saving={saving}
        />
      </DialogContent>
    </Dialog>
  );
}

export function CodeExecSettingsDialog({
  open,
  codeExecBackend,
  availableCodeExecBackends,
  e2bApiKey,
  e2bApiKeyConfigured,
  e2bApiKeyRemovalPending,
  dockerImage,
  dockerInitializing,
  dockerInitResult,
  saving,
  saveError,
  setCodeExecBackend,
  setE2bApiKey,
  setDockerImage,
  onInitDocker,
  onOpen,
  onRemoveE2bApiKey,
  onSave,
  onCancel
}: SaveDialogProps & {
  open: boolean;
  codeExecBackend: CodeExecBackend;
  availableCodeExecBackends: string[];
  e2bApiKey: string;
  e2bApiKeyConfigured: boolean;
  e2bApiKeyRemovalPending: boolean;
  dockerImage: string;
  dockerInitializing: boolean;
  dockerInitResult: { ok: boolean; error?: string } | null;
  setCodeExecBackend: (backend: CodeExecBackend) => void;
  setE2bApiKey: (key: string) => void;
  setDockerImage: (image: string) => void;
  onInitDocker: () => void;
  onOpen: () => void;
  onRemoveE2bApiKey: () => void;
}) {
  const t = useT();

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (nextOpen) onOpen();
        else onCancel();
      }}
      open={open}
    >
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HugeiconsIcon
              className="size-4"
              icon={FileCodeIcon}
            />{' '}
            {t('web.tools.codeExec')}
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>{t('web.tools.sandboxLabel')}</Label>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  { id: 'follow-system', label: t('web.tools.followSystemBackend') },
                  { id: 'docker', label: t('web.tools.dockerBackend') },
                  { id: 'e2b', label: t('web.tools.e2bBackend') }
                ] as const
              ).map(({ id, label }) => {
                const available = availableCodeExecBackends.includes(id);
                const unavailableHint =
                  id === 'docker'
                    ? t('web.tools.dockerInstallHint')
                    : id === 'e2b'
                      ? t('web.tools.e2bNotAvailable')
                      : undefined;
                return (
                  <button
                    className={`rounded-md border px-3 py-1.5 text-sm transition-opacity ${codeExecBackend === id ? 'border-ring bg-primary-subtle text-primary' : ''} ${!available ? 'cursor-not-allowed opacity-40' : ''}`}
                    disabled={!available}
                    key={id}
                    onClick={() => available && setCodeExecBackend(id)}
                    title={!available ? unavailableHint : undefined}
                    type="button"
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <p className="text-muted-foreground text-xs">
              {codeExecBackend === 'docker'
                ? t('web.tools.dockerDesc')
                : codeExecBackend === 'e2b'
                  ? t('web.tools.e2bDesc')
                  : t('web.tools.followSystemDesc')}
            </p>
          </div>

          {codeExecBackend === 'e2b' && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="e2b-api-key">{t('web.tools.e2bApiKey')}</Label>
              <Input
                id="e2b-api-key"
                onChange={(e) => setE2bApiKey(e.target.value)}
                placeholder={t('web.tools.e2bApiKeyPlaceholder')}
                value={e2bApiKey}
              />
              <CredentialActions
                configured={e2bApiKeyConfigured}
                onRemove={onRemoveE2bApiKey}
                pendingRemoval={e2bApiKeyRemovalPending}
                value={e2bApiKey}
              />
            </div>
          )}

          {codeExecBackend === 'docker' && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="docker-image">{t('web.tools.dockerImageLabel')}</Label>
              <Input
                id="docker-image"
                onChange={(e) => setDockerImage(e.target.value)}
                placeholder={t('web.tools.dockerImagePlaceholder')}
                value={dockerImage}
              />
              <div className="flex items-center gap-2">
                <Button
                  disabled={dockerInitializing}
                  onClick={onInitDocker}
                  size="sm"
                  variant="outline"
                >
                  {dockerInitializing ? (
                    <HugeiconsIcon
                      className="animate-spin"
                      icon={LoaderPinwheelIcon}
                    />
                  ) : null}
                  {dockerInitializing ? t('web.tools.dockerInitializing') : t('web.tools.dockerInitBtn')}
                </Button>
                {dockerInitResult && (
                  <span
                    className={`text-xs ${dockerInitResult.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}`}
                  >
                    {dockerInitResult.ok ? t('web.tools.dockerInitSuccess') : (dockerInitResult.error ?? 'Failed')}
                  </span>
                )}
              </div>
            </div>
          )}

          {saveError ? <p className="text-destructive text-xs">{saveError}</p> : null}
        </DialogBody>
        <SaveDialogActions
          onCancel={onCancel}
          onSave={onSave}
          saving={saving}
        />
      </DialogContent>
    </Dialog>
  );
}

export function EmailSettingsDialog({
  open,
  emailBackend,
  emailFrom,
  resendApiKey,
  resendApiKeyConfigured,
  resendApiKeyRemovalPending,
  smtpEnabled,
  smtpHost,
  smtpPort,
  smtpUser,
  smtpPass,
  smtpPassConfigured,
  smtpPassRemovalPending,
  smtpSecure,
  smtpClientName,
  saving,
  saveError,
  setEmailBackend,
  setEmailFrom,
  setResendApiKey,
  setSmtpEnabled,
  setSmtpHost,
  setSmtpPort,
  setSmtpUser,
  setSmtpPass,
  setSmtpSecure,
  setSmtpClientName,
  onRemoveResendApiKey,
  onRemoveSmtpPass,
  onSave,
  onCancel
}: SaveDialogProps & {
  open: boolean;
  emailBackend: EmailBackend;
  emailFrom: string;
  resendApiKey: string;
  resendApiKeyConfigured: boolean;
  resendApiKeyRemovalPending: boolean;
  smtpEnabled: boolean;
  smtpHost: string;
  smtpPort: string;
  smtpUser: string;
  smtpPass: string;
  smtpPassConfigured: boolean;
  smtpPassRemovalPending: boolean;
  smtpSecure: boolean;
  smtpClientName: string;
  setEmailBackend: (backend: EmailBackend) => void;
  setEmailFrom: (value: string) => void;
  setResendApiKey: (value: string) => void;
  setSmtpEnabled: (enabled: boolean) => void;
  setSmtpHost: (value: string) => void;
  setSmtpPort: (value: string) => void;
  setSmtpUser: (value: string) => void;
  setSmtpPass: (value: string) => void;
  setSmtpSecure: (secure: boolean) => void;
  setSmtpClientName: (value: string) => void;
  onRemoveResendApiKey: () => void;
  onRemoveSmtpPass: () => void;
}) {
  const t = useT();

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onCancel();
      }}
      open={open}
    >
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HugeiconsIcon
              className="size-4"
              icon={Mail01Icon}
            />{' '}
            {t('web.tools.email')}
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>{t('web.tools.emailBackend')}</Label>
            <div className="flex gap-2">
              {(['auto', 'smtp', 'resend'] as const).map((backend) => (
                <button
                  className={`rounded-md border px-3 py-1.5 text-sm ${emailBackend === backend ? 'border-ring bg-primary-subtle text-primary' : ''}`}
                  key={backend}
                  onClick={() => setEmailBackend(backend)}
                  type="button"
                >
                  {backend === 'auto' ? t('web.tools.searchProviderAuto') : backend === 'smtp' ? 'SMTP' : 'Resend'}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email-from">{t('web.tools.emailFromLabel')}</Label>
            <Input
              id="email-from"
              onChange={(e) => setEmailFrom(e.target.value)}
              placeholder="sender@example.com"
              type="email"
              value={emailFrom}
            />
          </div>
          {(emailBackend === 'resend' || emailBackend === 'auto') && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="resend-api-key">{t('web.tools.resendApiKey')}</Label>
              <Input
                id="resend-api-key"
                onChange={(e) => setResendApiKey(e.target.value)}
                placeholder={t('web.tools.credentialWriteOnlyPlaceholder')}
                value={resendApiKey}
              />
              <CredentialActions
                configured={resendApiKeyConfigured}
                onRemove={onRemoveResendApiKey}
                pendingRemoval={resendApiKeyRemovalPending}
                value={resendApiKey}
              />
            </div>
          )}
          <label className="flex items-center gap-2">
            <input
              checked={smtpEnabled}
              className="size-4"
              onChange={(e) => setSmtpEnabled(e.target.checked)}
              type="checkbox"
            />
            <span className="text-sm">{t('web.tools.configureSMTP')}</span>
          </label>
          {smtpEnabled && (
            <div className="flex flex-col gap-3 border-border/70 border-t pt-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="smtp-host">{t('web.tools.smtpHost')}</Label>
                  <Input
                    id="smtp-host"
                    onChange={(e) => setSmtpHost(e.target.value)}
                    placeholder="smtp.example.com"
                    value={smtpHost}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="smtp-port">{t('web.tools.smtpPort')}</Label>
                  <Input
                    id="smtp-port"
                    onChange={(e) => setSmtpPort(e.target.value)}
                    placeholder="465 or 587"
                    type="number"
                    value={smtpPort}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="smtp-user">{t('web.tools.smtpUser')}</Label>
                  <Input
                    id="smtp-user"
                    onChange={(e) => setSmtpUser(e.target.value)}
                    placeholder="user@example.com"
                    value={smtpUser}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="smtp-pass">{t('web.tools.smtpPass')}</Label>
                  <Input
                    id="smtp-pass"
                    onChange={(e) => setSmtpPass(e.target.value)}
                    placeholder={t('web.tools.credentialWriteOnlyPlaceholder')}
                    type="text"
                    value={smtpPass}
                  />
                  <CredentialActions
                    configured={smtpPassConfigured}
                    onRemove={onRemoveSmtpPass}
                    pendingRemoval={smtpPassRemovalPending}
                    value={smtpPass}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="smtp-client">{t('web.tools.smtpClientName')}</Label>
                  <Input
                    id="smtp-client"
                    onChange={(e) => setSmtpClientName(e.target.value)}
                    placeholder="Monad"
                    value={smtpClientName}
                  />
                </div>
              </div>
              <label className="flex items-center gap-2">
                <input
                  checked={smtpSecure}
                  className="size-4"
                  id="smtp-secure"
                  onChange={(e) => setSmtpSecure(e.target.checked)}
                  type="checkbox"
                />
                <span className="text-sm">{t('web.tools.smtpSecure')}</span>
              </label>
            </div>
          )}
          {saveError ? <p className="text-destructive text-xs">{saveError}</p> : null}
        </DialogBody>
        <SaveDialogActions
          onCancel={onCancel}
          onSave={onSave}
          saving={saving}
        />
      </DialogContent>
    </Dialog>
  );
}
