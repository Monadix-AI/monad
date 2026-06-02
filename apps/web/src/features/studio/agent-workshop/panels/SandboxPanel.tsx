import type { SandboxMode } from '@monad/protocol';
import type { SandboxPanelProps } from './types';

import { Confirm, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton } from '@monad/ui';
import { useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { ShellLink } from '#/components/ShellLink';
import { SwitchSetting } from '#/components/ui/switch-setting';
import { CredentialHelp } from '../../credentials-settings/CredentialHelp';
import { duplicateGrantedEnvironmentVariables, toggleCredentialGrant } from '../agent-credential-grants';

const INHERIT = '__inherit__';
const MODES: Array<{ descriptionKey: string; mode: SandboxMode }> = [
  { mode: 'workspace', descriptionKey: 'web.studio.agentEditor.sandbox.description.workspace' },
  { mode: 'home', descriptionKey: 'web.studio.agentEditor.sandbox.description.home' },
  { mode: 'ephemeral', descriptionKey: 'web.studio.agentEditor.sandbox.description.ephemeral' },
  { mode: 'unrestricted', descriptionKey: 'web.studio.agentEditor.sandbox.description.unrestricted' }
];

export function SandboxPanel(props: SandboxPanelProps) {
  const t = useT();
  const [pendingUnrestricted, setPendingUnrestricted] = useState(false);
  const selected = MODES.find((item) => item.mode === props.sandboxMode);
  const duplicateEnvironmentVariables = duplicateGrantedEnvironmentVariables(props.credentials, props.credentialIds);

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="flow-sandbox-mode">{t('web.studio.agentEditor.sandbox.mode')}</Label>
        <Select
          onValueChange={(value) => {
            if (value === 'unrestricted') {
              setPendingUnrestricted(true);
              return;
            }
            setPendingUnrestricted(false);
            props.setSandboxMode(value === INHERIT ? '' : (value as SandboxMode));
          }}
          value={props.sandboxMode || INHERIT}
        >
          <SelectTrigger
            className="w-full"
            id="flow-sandbox-mode"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT}>{t('web.studio.agentEditor.sandbox.default')}</SelectItem>
            {MODES.map(({ mode }) => (
              <SelectItem
                key={mode}
                value={mode}
              >
                {mode}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">
          {selected ? t(selected.descriptionKey) : t('web.studio.agentEditor.sandbox.defaultHint')}
        </p>
      </div>
      <Confirm
        cancelLabel={t('web.studio.agentEditor.sandbox.keep')}
        confirmLabel={t('web.studio.agentEditor.sandbox.confirm')}
        confirmVariant="destructive"
        description={t('web.studio.agentEditor.sandbox.confirmHint')}
        onConfirm={() => {
          props.setSandboxMode('unrestricted');
          setPendingUnrestricted(false);
        }}
        onOpenChange={setPendingUnrestricted}
        open={pendingUnrestricted}
        title={t('web.studio.agentEditor.sandbox.confirmTitle')}
      />

      <section className="space-y-3 border-t pt-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="font-medium text-sm">{t('web.credentials.agentGrantsTitle')}</h3>
              <CredentialHelp />
            </div>
            <p className="mt-1 text-muted-foreground text-xs">{t('web.credentials.agentGrantsDescription')}</p>
          </div>
          <ShellLink
            className="shrink-0 text-primary text-xs underline underline-offset-4"
            href="/studio/credentials"
          >
            {t('web.credentials.manage')}
          </ShellLink>
        </div>

        {props.credentialCapabilityLoading ? <Skeleton className="h-16 w-full rounded-xl" /> : null}
        {!props.credentialCapabilityLoading && props.credentialCapability?.available === false ? (
          <div
            aria-live="polite"
            className="rounded-xl border border-warning/40 bg-warning/10 p-3"
          >
            <p className="font-medium text-sm">{t('web.credentials.unavailableTitle')}</p>
            <p className="mt-1 text-muted-foreground text-xs">{t('web.credentials.agentUnavailableDescription')}</p>
          </div>
        ) : null}
        {!props.credentialCapabilityLoading && props.credentialCapability?.available ? (
          <p className="rounded-xl border border-success/30 bg-success/5 p-3 text-muted-foreground text-xs">
            {t('web.credentials.agentReady')}
          </p>
        ) : null}

        {props.credentialsLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-20 w-full rounded-xl" />
            <Skeleton className="h-20 w-full rounded-xl" />
          </div>
        ) : null}
        {!props.credentialsLoading && props.credentialsError ? (
          <p
            aria-live="polite"
            className="rounded-xl border border-destructive/30 p-3 text-destructive text-xs"
          >
            {t('web.credentials.agentLoadError')}
          </p>
        ) : null}
        {!props.credentialsLoading && !props.credentialsError && props.credentials.length === 0 ? (
          <p className="rounded-xl border border-dashed p-4 text-muted-foreground text-sm">
            {t('web.credentials.agentEmpty')}
          </p>
        ) : null}
        {!props.credentialsLoading && !props.credentialsError && props.credentials.length > 0 ? (
          <div className="divide-y rounded-xl border">
            {props.credentials.map((credential) => {
              const checked = props.credentialIds.includes(credential.id);
              return (
                <SwitchSetting
                  checked={checked}
                  className="px-3 py-3"
                  description={
                    <>
                      {credential.description ? <p>{credential.description}</p> : null}
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
                        <code className="rounded bg-muted px-1.5 py-0.5 text-foreground">
                          {credential.environmentVariable}
                        </code>
                        <span>{credential.allowedHosts.join(', ')}</span>
                        {!credential.configured ? (
                          <span className="text-warning">{t('web.credentials.notConfigured')}</span>
                        ) : null}
                      </div>
                    </>
                  }
                  id={`agent-credential-${credential.id}`}
                  key={credential.id}
                  onCheckedChange={() =>
                    props.setCredentialIds((current) => toggleCredentialGrant(current, credential.id))
                  }
                  title={credential.label}
                />
              );
            })}
          </div>
        ) : null}

        {duplicateEnvironmentVariables.length > 0 ? (
          <p
            aria-live="polite"
            className="text-destructive text-xs"
          >
            {t('web.credentials.duplicateEnvironmentVariables', {
              names: duplicateEnvironmentVariables.join(', ')
            })}
          </p>
        ) : null}
        {props.credentialError ? (
          <p
            aria-live="polite"
            className="text-destructive text-xs"
          >
            {props.credentialError}
          </p>
        ) : null}
      </section>
    </div>
  );
}
