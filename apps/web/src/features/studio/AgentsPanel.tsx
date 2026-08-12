import type { Agent, AgentId } from '@monad/protocol';
import type { StudioSectionProps } from './section-registry';

import { BotIcon, Delete02Icon, LoaderPinwheelIcon, PlusSignIcon, Upload01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  agentSelectors,
  useCreateAgentMutation,
  useDeleteAgentMutation,
  useGetAppearanceQuery,
  useListAgentsQuery
} from '@monad/client-rtk';
import { Badge, Button, Confirm, Skeleton, Textarea } from '@monad/ui';
import { AgentInstanceAvatar } from '@monad/ui/components/AgentAvatar';
import { useMemo, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { PanelShell, PanelShellBody } from '#/components/ui/panel-shell';
import { agentDetailsPath, agentEditPath } from '#/features/shell/routing/paths';
import { replaceShellUrl } from '#/hooks/use-shell-location';
import { parseClaudeSubagent } from '#/lib/parse-agent-import';
import { agentCardAvatar } from './agent-card-avatar';
import { AgentDetails } from './agent-details/AgentDetails';
import { parseAgentDetailsRoute } from './agent-details/agent-details-route';
import { AgentEditor } from './agent-workshop/AgentEditor';
import { OpenaiCompatSettings } from './api-settings';
import { StudioBreadcrumbHeader } from './StudioBreadcrumbHeader';
import { MonadAgentUsage } from './Usage';

function AgentsListSkeleton() {
  return (
    <div
      aria-busy="true"
      className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-3"
    >
      {Array.from({ length: 5 }, (_, i) => `agent-skeleton-${i}`).map((key) => (
        <div
          className="flex min-h-24 items-center gap-3 rounded-xl border bg-card p-2"
          key={key}
        >
          <Skeleton className="mx-1.5 size-10 shrink-0 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5 px-1.5 py-1.5">
            <div className="flex items-center gap-2">
              <Skeleton className="h-4 w-36 rounded" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
            <Skeleton className="h-3 w-4/5 rounded" />
            <Skeleton className="h-5 w-28 rounded-md" />
          </div>
          <Skeleton className="mx-1 size-7 shrink-0 rounded-md" />
        </div>
      ))}
    </div>
  );
}

/** Agents area of Studio: a master list of agents ↔ a single-agent editor. */
export function AgentsPanel({ onClose, subpath = [] }: StudioSectionProps) {
  const t = useT();
  const { data, isLoading } = useListAgentsQuery();
  const { data: appearance } = useGetAppearanceQuery();
  const [createAgent, { isLoading: creating }] = useCreateAgentMutation();
  const [deleteAgent, { isLoading: deleting }] = useDeleteAgentMutation();
  const [confirmDelete, setConfirmDelete] = useState<AgentId | null>(null);
  const [deleteError, setDeleteError] = useState<string>();
  const [importing, setImporting] = useState(false);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState<string>();

  const agents = data ? agentSelectors.selectAll(data) : [];
  const agentToDelete = agents.find((agent) => agent.id === confirmDelete);
  const selectedAgentId = (subpath[0] as AgentId | undefined) ?? null;
  const selectedRoute = parseAgentDetailsRoute(subpath);

  // Surface duplicate names so the user resolves them (we never silently shadow).
  const dupNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of agents) counts.set(a.name, (counts.get(a.name) ?? 0) + 1);
    return new Set([...counts].filter(([, n]) => n > 1).map(([name]) => name));
  }, [agents]);

  if (selectedAgentId && selectedRoute.mode === 'edit') {
    return (
      <AgentEditor
        agentId={selectedAgentId}
        onClose={onClose}
      />
    );
  }

  if (selectedAgentId) {
    return (
      <AgentDetails
        agentId={selectedAgentId}
        subpath={subpath}
      />
    );
  }

  const handleCreate = async () => {
    const res = await createAgent({
      name: t('web.studio.newAgentName'),
      capabilities: [],
      credentialIds: [],
      memory: { enabled: true, advanced: true, autoConsolidate: false, intervalMinutes: 30 }
    }).unwrap();
    replaceShellUrl(agentEditPath(res.agent.id));
  };

  const handleImport = async () => {
    setImportError(undefined);
    let parsed: ReturnType<typeof parseClaudeSubagent>;
    try {
      parsed = parseClaudeSubagent(importText);
    } catch (e) {
      setImportError((e as Error).message);
      return;
    }
    try {
      const res = await createAgent({
        name: parsed.name,
        model: parsed.model,
        prompt: parsed.prompt,
        capabilities: [],
        credentialIds: [],
        memory: { enabled: true, advanced: true, autoConsolidate: false, intervalMinutes: 30 }
      }).unwrap();
      setImporting(false);
      setImportText('');
      replaceShellUrl(agentEditPath(res.agent.id));
    } catch (e) {
      setImportError((e as { message?: string }).message ?? 'Failed to create agent');
    }
  };

  return (
    <PanelShell>
      <StudioBreadcrumbHeader
        actions={
          <Button
            disabled={creating}
            onClick={() => void handleCreate()}
            size="sm"
            variant="ghost"
          >
            {creating ? (
              <HugeiconsIcon
                className="animate-spin"
                icon={LoaderPinwheelIcon}
              />
            ) : (
              <HugeiconsIcon icon={PlusSignIcon} />
            )}
            {t('web.studio.newAgent')}
          </Button>
        }
        title={t('web.studio.agents')}
      />

      <PanelShellBody className="overflow-y-auto">
        <div className="flex flex-col gap-3 p-5">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-3">
            {importing && (
              <div className="col-span-full flex flex-col gap-2 rounded-lg border bg-card p-4">
                <div className="flex items-center gap-2">
                  <HugeiconsIcon
                    className="size-4 text-muted-foreground"
                    icon={Upload01Icon}
                  />
                  <span className="font-medium text-sm">{t('web.studio.importTitle')}</span>
                </div>
                <p className="text-muted-foreground text-xs">{t('web.studio.importHint')}</p>
                <Textarea
                  className="min-h-40 font-ui text-[13px]"
                  onChange={(e) => setImportText(e.target.value)}
                  placeholder={'---\nname: code-reviewer\ndescription: ...\n---\nYou are ...'}
                  value={importText}
                />
                {importError && <p className="text-destructive text-xs">{importError}</p>}
                <div className="flex items-center gap-2">
                  <Button
                    disabled={creating || !importText.trim()}
                    onClick={() => void handleImport()}
                    size="sm"
                  >
                    {creating ? (
                      <HugeiconsIcon
                        className="animate-spin"
                        icon={LoaderPinwheelIcon}
                      />
                    ) : (
                      <HugeiconsIcon icon={Upload01Icon} />
                    )}
                    {t('web.studio.import')}
                  </Button>
                  <Button
                    onClick={() => {
                      setImporting(false);
                      setImportError(undefined);
                    }}
                    size="sm"
                    variant="ghost"
                  >
                    {t('web.common.cancel')}
                  </Button>
                </div>
              </div>
            )}

            {isLoading && (
              <div className="col-span-full">
                <AgentsListSkeleton />
              </div>
            )}

            {!isLoading && agents.length === 0 && (
              <div className="col-span-full mx-auto flex max-w-xs flex-col items-center gap-3 py-16 text-center">
                <HugeiconsIcon
                  className="size-8 text-muted-foreground/60"
                  icon={BotIcon}
                />
                <p className="font-medium text-sm">{t('web.studio.emptyTitle')}</p>
                <p className="text-muted-foreground text-sm">{t('web.studio.emptyBody')}</p>
                <Button
                  disabled={creating}
                  onClick={() => void handleCreate()}
                  size="sm"
                >
                  <HugeiconsIcon icon={PlusSignIcon} />
                  {t('web.studio.createFirst')}
                </Button>
              </div>
            )}

            {agents.map((a: Agent) => (
              <div
                className="group/agent-card relative flex min-h-24 items-center rounded-xl border bg-card p-2 transition-[background-color,border-color] duration-150 focus-within:border-ring/60 focus-within:ring-2 focus-within:ring-ring/20 hover:border-ring/40 hover:bg-accent/40"
                key={a.id}
              >
                <button
                  aria-labelledby={`agent-card-${a.id}-name`}
                  className="absolute inset-0 rounded-xl outline-none active:bg-accent/60"
                  onClick={() => replaceShellUrl(agentDetailsPath(a.id))}
                  type="button"
                />
                <span className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-3 px-1.5 py-1.5">
                  <AgentInstanceAvatar
                    agent={agentCardAvatar(a, appearance?.avatarStyle)}
                    size={40}
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <span
                        className="min-w-0 max-w-full truncate font-medium text-sm"
                        id={`agent-card-${a.id}-name`}
                      >
                        {a.name}
                      </span>
                      {dupNames.has(a.name) && (
                        <Badge
                          className="border-destructive/40 bg-destructive/10 text-destructive"
                          variant="outline"
                        >
                          {t('web.studio.duplicateName')}
                        </Badge>
                      )}
                      {a.visibility?.subagentCallable && (
                        <Badge variant="secondary">{t('web.studio.badgeSubagent')}</Badge>
                      )}
                      {a.visibility?.public && <Badge variant="secondary">{t('web.studio.badgePublic')}</Badge>}
                    </span>
                    <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span className="max-w-full truncate rounded-md bg-muted/70 px-1.5 py-0.5 font-ui">
                        {a.model ?? a.modelAlias ?? t('web.studio.modelInherit')}
                      </span>
                      {a.hasPrompt && <span className="whitespace-nowrap">· {t('web.studio.hasPrompt')}</span>}
                      {a.sandboxMode && <span className="whitespace-nowrap">· {a.sandboxMode}</span>}
                    </span>
                  </span>
                </span>
                <span className="relative z-10 flex shrink-0 items-center text-muted-foreground opacity-70 transition-[color,opacity] group-focus-within/agent-card:opacity-100 group-hover/agent-card:opacity-100">
                  <Button
                    aria-label={t('web.studio.deleteAgent')}
                    className="size-7"
                    onClick={() => {
                      setDeleteError(undefined);
                      setConfirmDelete(a.id);
                    }}
                    size="icon"
                    variant="ghost"
                  >
                    <HugeiconsIcon
                      className="size-3.5"
                      icon={Delete02Icon}
                    />
                  </Button>
                </span>
              </div>
            ))}
          </div>

          <Confirm
            cancelLabel={t('web.common.cancel')}
            confirmLabel={t('web.common.delete')}
            confirmVariant="destructive"
            description={t('web.studio.deleteAgentConfirmDescription', { name: agentToDelete?.name ?? '' })}
            error={deleteError}
            onConfirm={() => {
              if (!confirmDelete) return;
              setDeleteError(undefined);
              void deleteAgent(confirmDelete)
                .unwrap()
                .then(() => setConfirmDelete(null))
                .catch((error: unknown) => {
                  setDeleteError(error instanceof Error ? error.message : t('web.studio.deleteAgentFailed'));
                });
            }}
            onOpenChange={(open) => {
              if (!open) {
                setConfirmDelete(null);
                setDeleteError(undefined);
              }
            }}
            open={confirmDelete !== null}
            pending={deleting}
            pendingLabel={t('web.studio.deletingAgent')}
            title={t('web.studio.deleteAgentConfirmTitle', { name: agentToDelete?.name ?? '' })}
          />

          <OpenaiCompatSettings
            embedded
            onClose={onClose}
          />

          <MonadAgentUsage />
        </div>
      </PanelShellBody>
    </PanelShell>
  );
}
