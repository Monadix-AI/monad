'use client';

import type { ExternalAgentSessionState, ExternalAgentSessionView, WorkplaceProject } from '@monad/protocol';

import {
  ArrowRight01Icon,
  BotIcon,
  Folder01Icon,
  MessageMultiple01Icon,
  PuzzleIcon,
  TerminalIcon,
  UserMultiple02Icon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  externalAgentSessionSelectors,
  sessionAdapter,
  sessionSelectors,
  useListLiveExternalAgentSessionsQuery,
  useListSessionsQuery,
  useListWorkplaceProjectsQuery,
  workplaceProjectAdapter,
  workplaceProjectSelectors
} from '@monad/client-rtk';
import { Button, ProductIcon } from '@monad/ui';

import { useT } from '#/components/I18nProvider';
import { ShellLink } from '#/components/ShellLink';
import { PanelShell, PanelShellBody } from '#/components/ui/panel-shell';
import { studioPath } from '#/features/routes/route-paths';
import { useExternalAgentSettings } from '#/hooks/use-external-agent-settings';
import { OverviewIllustration } from './OverviewIllustration';
import { StudioBreadcrumbHeader } from './StudioBreadcrumbHeader';
import { MeshUsage } from './Usage';

const AGENT_STATE_STYLE: Record<ExternalAgentSessionState, string> = {
  running:
    'bg-[color-mix(in_srgb,var(--success,var(--accent-green))_16%,transparent)] text-[color-mix(in_srgb,var(--success,var(--accent-green))_72%,var(--foreground))]',
  starting:
    'bg-[color-mix(in_srgb,var(--accent-blue)_14%,transparent)] text-[color-mix(in_srgb,var(--accent-blue)_70%,var(--foreground))]',
  exited: 'bg-muted text-muted-foreground',
  stopped: 'bg-muted text-muted-foreground',
  failed: 'bg-destructive/12 text-destructive'
};

function agentStateLabel(t: ReturnType<typeof useT>, state: ExternalAgentSessionState): string {
  return t(`web.studio.agentState.${state}` as const);
}

function AgentRuntimeRow({ session }: { session: ExternalAgentSessionView }) {
  const t = useT();
  return (
    <div className="flex items-center gap-2.5 rounded-lg border bg-background px-3 py-2">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md border bg-card">
        <ProductIcon
          className="size-3.5"
          product={session.productIcon ?? session.provider}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-sm">{session.agentName}</span>
        <span className="block truncate text-muted-foreground text-xs">{session.provider}</span>
      </span>
      <span className={`shrink-0 rounded-full px-2 py-0.5 font-medium text-[11px] ${AGENT_STATE_STYLE[session.state]}`}>
        {agentStateLabel(t, session.state)}
      </span>
    </div>
  );
}

function groupByTarget(sessions: ExternalAgentSessionView[]): [string, ExternalAgentSessionView[]][] {
  const groups = new Map<string, ExternalAgentSessionView[]>();
  for (const session of sessions) {
    const list = groups.get(session.sessionId);
    if (list) list.push(session);
    else groups.set(session.sessionId, [session]);
  }
  return [...groups.entries()];
}

function AgentRuntimesSection({ projects }: { projects: WorkplaceProject[] }) {
  const t = useT();
  const { data } = useListLiveExternalAgentSessionsQuery(undefined);
  const sessions = data ? externalAgentSessionSelectors.selectAll(data.sessions) : [];
  const { data: sessionData } = useListSessionsQuery(undefined);
  const allSessions = sessionSelectors.selectAll(sessionData?.sessions ?? sessionAdapter.getInitialState());
  const titleFor = (targetId: string): string => {
    const session = allSessions.find((s) => s.id === targetId);
    if (session) return session.title;
    return projects.find((p) => p.id === targetId)?.title ?? targetId;
  };
  return (
    <section className="rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <HugeiconsIcon
          className="size-4 text-muted-foreground"
          icon={PuzzleIcon}
        />
        <div className="min-w-0">
          <h2 className="font-medium text-base">{t('web.studio.liveRuntimesTitle')}</h2>
          <p className="mt-1 text-muted-foreground text-sm">{t('web.studio.liveRuntimesDesc')}</p>
        </div>
      </div>
      <div className="flex flex-col gap-3 p-3">
        {sessions.length === 0 ? (
          <p className="px-1 py-2 text-muted-foreground text-sm">{t('web.studio.liveRuntimesEmpty')}</p>
        ) : (
          groupByTarget(sessions).map(([targetId, rows]) => (
            <div
              className="flex flex-col gap-1.5"
              key={targetId}
            >
              <p className="truncate px-1 text-muted-foreground text-xs">{titleFor(targetId)}</p>
              {rows.map((session) => (
                <AgentRuntimeRow
                  key={session.id}
                  session={session}
                />
              ))}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function MeshAction({
  body,
  href,
  icon,
  title
}: {
  body: string;
  href: string;
  icon: typeof TerminalIcon;
  title: string;
}) {
  return (
    <Button
      asChild
      className="h-auto justify-start px-3 py-3 text-left"
      variant="ghost"
    >
      <ShellLink href={href}>
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-background text-[color-mix(in_srgb,var(--info)_70%,var(--foreground))]">
          <HugeiconsIcon
            className="size-4"
            icon={icon}
          />
        </span>
        <span className="min-w-0">
          <span className="block font-medium text-sm">{title}</span>
          <span className="mt-1 block max-w-[48ch] text-muted-foreground text-xs">{body}</span>
        </span>
      </ShellLink>
    </Button>
  );
}

export function MeshOverview() {
  const t = useT();
  const externalAgent = useExternalAgentSettings();
  const projects = useListWorkplaceProjectsQuery(undefined);
  const externalAgentCount = externalAgent.agents.length;
  const projectList = workplaceProjectSelectors.selectAll(
    projects.data?.projects ?? workplaceProjectAdapter.getInitialState()
  );
  const projectCount = projectList.length;

  return (
    <PanelShell>
      <StudioBreadcrumbHeader title={t('web.studio.meshOverview')} />
      <PanelShellBody>
        <div className="mx-auto grid max-w-6xl gap-5 p-4 pb-24 lg:grid-cols-[minmax(0,1fr)_19rem] lg:p-6 lg:pb-24">
          <main className="flex min-w-0 flex-col gap-5">
            <section className="grid gap-5 rounded-xl border border-[color-mix(in_srgb,var(--info)_20%,var(--border))] bg-[color-mix(in_srgb,var(--info)_5%,var(--card))] px-5 py-5 shadow-xs md:grid-cols-[minmax(0,1fr)_17rem] md:items-center">
              <div className="min-w-0">
                <p className="max-w-[72ch] text-muted-foreground text-sm">{t('web.studio.meshOverviewDesc')}</p>
                <div className="mt-5 flex flex-wrap gap-2">
                  <Button
                    asChild
                    size="sm"
                  >
                    <ShellLink href={studioPath('externalAgents')}>{t('web.studio.connectExternalAgent')}</ShellLink>
                  </Button>
                  <Button
                    asChild
                    size="sm"
                    variant="ghost"
                  >
                    <ShellLink href="/">{t('web.studio.openWorkplace')}</ShellLink>
                  </Button>
                </div>
              </div>
              <OverviewIllustration
                className="hidden md:block"
                variant="mesh"
              />
            </section>

            <section className="rounded-xl border bg-card">
              <div className="border-b px-4 py-3">
                <h2 className="font-medium text-base">{t('web.studio.meshSetupTitle')}</h2>
                <p className="mt-1 text-muted-foreground text-sm">{t('web.studio.meshSetupDesc')}</p>
              </div>
              <div className="grid gap-1 p-2">
                <MeshAction
                  body={
                    externalAgentCount > 0
                      ? t('web.studio.externalAgentReady', { count: externalAgentCount })
                      : t('web.studio.externalAgentNeeded')
                  }
                  href={studioPath('externalAgents')}
                  icon={TerminalIcon}
                  title={t('web.studio.externalAgents')}
                />
                <MeshAction
                  body={
                    projectCount > 0
                      ? t('web.studio.projectReady', { count: projectCount })
                      : t('web.studio.projectNeeded')
                  }
                  href="/"
                  icon={Folder01Icon}
                  title={t('web.studio.workplaceProjects')}
                />
                <div className="mx-2 mb-2 rounded-lg border border-dashed bg-muted/25 px-3 py-2">
                  <p className="text-muted-foreground text-xs">{t('web.studio.workplaceProjectsIncludes')}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <span className="inline-flex items-center gap-1.5 rounded-full border bg-background px-2 py-1 text-muted-foreground text-xs">
                      <HugeiconsIcon
                        className="size-3.5"
                        icon={UserMultiple02Icon}
                      />
                      {t('web.studio.projectMembers')}
                    </span>
                    <span className="inline-flex items-center gap-1.5 rounded-full border bg-background px-2 py-1 text-muted-foreground text-xs">
                      <HugeiconsIcon
                        className="size-3.5"
                        icon={MessageMultiple01Icon}
                      />
                      {t('web.studio.tasksAndSessions')}
                    </span>
                  </div>
                </div>
              </div>
            </section>

            <AgentRuntimesSection projects={projectList} />

            <MeshUsage />
          </main>

          <aside className="hidden min-w-0 flex-col gap-4 lg:flex">
            <section className="rounded-xl border bg-card px-4 py-4">
              <h2 className="font-medium text-sm">{t('web.studio.meshBoundaryTitle')}</h2>
              <p className="mt-2 text-muted-foreground text-sm">{t('web.studio.meshBoundaryDesc')}</p>
            </section>
            <section className="rounded-xl border bg-card px-4 py-4">
              <h2 className="font-medium text-sm">{t('web.studio.runtimeBridgeTitle')}</h2>
              <p className="mt-2 text-muted-foreground text-sm">{t('web.studio.runtimeBridgeDesc')}</p>
              <Button
                asChild
                className="mt-4"
                size="sm"
                variant="secondary"
              >
                <ShellLink href={studioPath('runtime')}>
                  {t('web.studio.openRuntimeOverview')}
                  <HugeiconsIcon icon={ArrowRight01Icon} />
                </ShellLink>
              </Button>
            </section>
          </aside>
        </div>
      </PanelShellBody>
    </PanelShell>
  );
}

export function MeshPlaceholder({ kind }: { kind: 'projects' | 'members' | 'tasks' }) {
  const t = useT();
  const copy = {
    members: {
      title: t('web.studio.projectMembers'),
      body: t('web.studio.projectMembersPlaceholder')
    },
    projects: {
      title: t('web.studio.workplaceProjects'),
      body: t('web.studio.workplaceProjectsPlaceholder')
    },
    tasks: {
      title: t('web.studio.tasksAndSessions'),
      body: t('web.studio.meshTasksPlaceholder')
    }
  }[kind];

  return (
    <PanelShell>
      <StudioBreadcrumbHeader title={copy.title} />
      <PanelShellBody>
        <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6 pb-24">
          <div className="rounded-xl border bg-card px-5 py-5">
            <div className="flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-[color-mix(in_srgb,var(--info)_10%,transparent)] text-[color-mix(in_srgb,var(--info)_70%,var(--foreground))]">
                <HugeiconsIcon
                  className="size-4"
                  icon={BotIcon}
                />
              </span>
              <div className="min-w-0">
                <h2 className="font-medium text-base">{copy.title}</h2>
                <p className="mt-2 text-muted-foreground text-sm">{copy.body}</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    asChild
                    size="sm"
                  >
                    <ShellLink href="/">{t('web.studio.openWorkplace')}</ShellLink>
                  </Button>
                  <Button
                    asChild
                    size="sm"
                    variant="ghost"
                  >
                    <ShellLink href={studioPath('mesh')}>{t('web.studio.openMeshOverview')}</ShellLink>
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </PanelShellBody>
    </PanelShell>
  );
}
