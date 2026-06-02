import type { AgentCredentialView, CreateAgentCredentialRequest, UpdateAgentCredentialRequest } from '@monad/protocol';

import { Key01Icon, PlusSignIcon, ShieldEnergyIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  agentSelectors,
  useCreateAgentCredentialMutation,
  useDeleteAgentCredentialMutation,
  useGetAgentCredentialCapabilityQuery,
  useListAgentCredentialsQuery,
  useListAgentsQuery,
  useUpdateAgentCredentialMutation
} from '@monad/client-rtk';
import { Button } from '@monad/ui';
import { useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { PanelShell, PanelShellBody } from '#/components/ui/panel-shell';
import { StudioBreadcrumbHeader } from '#/features/studio/StudioBreadcrumbHeader';
import { CredentialCard } from './CredentialCard';
import { CredentialDialog } from './CredentialDialog';
import { CredentialHelp } from './CredentialHelp';

function mutationMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string')
    return error.message;
  return fallback;
}

export function CredentialsSettings(_props: { onClose: () => void }) {
  const t = useT();
  const credentialsQuery = useListAgentCredentialsQuery();
  const agentsQuery = useListAgentsQuery();
  const capabilityQuery = useGetAgentCredentialCapabilityQuery();
  const [createCredential, createState] = useCreateAgentCredentialMutation();
  const [updateCredential, updateState] = useUpdateAgentCredentialMutation();
  const [deleteCredential, deleteState] = useDeleteAgentCredentialMutation();
  const [dialog, setDialog] = useState<'create' | AgentCredentialView | null>(null);
  const credentials = credentialsQuery.data?.credentials ?? [];
  const agents = agentsQuery.data ? agentSelectors.selectAll(agentsQuery.data) : [];
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));
  const dialogError = createState.error ?? updateState.error;
  const closeDialog = () => {
    setDialog(null);
    createState.reset();
    updateState.reset();
  };
  const submit = async (request: CreateAgentCredentialRequest | UpdateAgentCredentialRequest) => {
    if (dialog === 'create') await createCredential(request as CreateAgentCredentialRequest).unwrap();
    else if (dialog) {
      await updateCredential({ credentialId: dialog.id, patch: request as UpdateAgentCredentialRequest }).unwrap();
    }
    closeDialog();
  };

  return (
    <PanelShell>
      <StudioBreadcrumbHeader
        actions={
          <Button
            className="gap-1.5"
            onClick={() => setDialog('create')}
            size="sm"
          >
            <HugeiconsIcon
              className="size-4"
              icon={PlusSignIcon}
            />
            {t('web.credentials.create')}
          </Button>
        }
        title={t('web.credentials.title')}
      />
      <PanelShellBody>
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 p-4 pb-24 md:p-6">
          <section className="flex items-start gap-3 rounded-xl border bg-card px-4 py-4 shadow-xs">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <HugeiconsIcon
                className="size-4"
                icon={Key01Icon}
              />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h1 className="font-medium text-base">{t('web.credentials.registryTitle')}</h1>
                <CredentialHelp />
              </div>
              <p className="mt-1 max-w-[72ch] text-muted-foreground text-sm">
                {t('web.credentials.registryDescription')}
              </p>
            </div>
          </section>

          {capabilityQuery.data && !capabilityQuery.data.available ? (
            <section className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4">
              <HugeiconsIcon
                className="mt-0.5 size-4 text-destructive"
                icon={ShieldEnergyIcon}
              />
              <div>
                <h2 className="font-medium text-sm">{t('web.credentials.unavailableTitle')}</h2>
                <p className="mt-1 text-muted-foreground text-sm">{t('web.credentials.unavailableDescription')}</p>
              </div>
            </section>
          ) : null}

          {credentialsQuery.isLoading ? (
            <p className="text-muted-foreground text-sm">{t('web.common.loading')}</p>
          ) : null}
          {credentialsQuery.isError ? (
            <div className="rounded-xl border border-destructive/30 p-4 text-destructive text-sm">
              {t('web.credentials.loadError')}
            </div>
          ) : null}
          {!credentialsQuery.isLoading && !credentialsQuery.isError && credentials.length === 0 ? (
            <div className="rounded-xl border border-dashed px-5 py-10 text-center">
              <p className="font-medium text-sm">{t('web.credentials.emptyTitle')}</p>
              <p className="mx-auto mt-1 max-w-lg text-muted-foreground text-sm">
                {t('web.credentials.emptyDescription')}
              </p>
            </div>
          ) : null}
          <div className="flex flex-col gap-3">
            {credentials.map((credential) => (
              <CredentialCard
                affectedAgentNames={credential.authorizedAgentIds.map((agentId) => agentNames.get(agentId) ?? agentId)}
                credential={credential}
                deleting={deleteState.isLoading}
                key={credential.id}
                onDelete={async () => {
                  await deleteCredential(credential.id).unwrap();
                }}
                onEdit={() => setDialog(credential)}
              />
            ))}
          </div>

          <section
            className="scroll-mt-20 rounded-xl border bg-muted/20 px-5 py-5"
            id="how-to-use"
          >
            <h2 className="font-medium text-base">{t('web.credentials.howToUse')}</h2>
            <p className="mt-1 max-w-[72ch] text-muted-foreground text-sm">{t('web.credentials.scopeNotice')}</p>
            <ol className="mt-4 grid gap-3 md:grid-cols-2">
              {(['createStep', 'grantStep', 'referenceStep', 'proxyStep'] as const).map((key, index) => (
                <li
                  className="flex gap-3 rounded-lg bg-background px-3 py-3 text-sm"
                  key={key}
                >
                  <span className="font-medium text-muted-foreground tabular-nums">{index + 1}</span>
                  <span>{t(`web.credentials.${key}`)}</span>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </PanelShellBody>

      {dialog ? (
        <CredentialDialog
          busy={createState.isLoading || updateState.isLoading}
          credential={dialog === 'create' ? undefined : dialog}
          error={dialogError ? mutationMessage(dialogError, t('web.credentials.mutationError')) : undefined}
          key={dialog === 'create' ? 'create' : dialog.id}
          onClose={closeDialog}
          onSubmit={submit}
        />
      ) : null}
    </PanelShell>
  );
}
