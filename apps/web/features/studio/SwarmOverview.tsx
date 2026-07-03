'use client';

import {
  ArrowRight01Icon,
  BotIcon,
  Folder01Icon,
  MessageMultiple01Icon,
  Plug01Icon,
  TerminalIcon,
  UserMultiple02Icon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useListWorkplaceProjectsQuery } from '@monad/client-rtk';
import { Button, ScrollArea } from '@monad/ui';
import Link from 'next/link';

import { useT } from '@/components/I18nProvider';
import { PanelShell } from '@/components/ui/panel-shell';
import { studioPath } from '@/features/routes/route-paths';
import { useFrameworkAgentSettings } from '@/hooks/use-framework-agent-settings';
import { useNativeCliAgentSettings } from '@/hooks/use-native-cli-agent-settings';
import { OverviewIllustration } from './OverviewIllustration';
import { StudioBreadcrumbHeader } from './StudioBreadcrumbHeader';

function SwarmAction({
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
      <Link href={href}>
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
      </Link>
    </Button>
  );
}

export function SwarmOverview() {
  const t = useT();
  const nativeCli = useNativeCliAgentSettings();
  const framework = useFrameworkAgentSettings();
  const projects = useListWorkplaceProjectsQuery(undefined);
  const nativeCliCount = nativeCli.agents.length;
  const frameworkCount = framework.agents.length;
  const projectCount = projects.data?.projects.ids.length ?? 0;

  return (
    <PanelShell>
      <StudioBreadcrumbHeader
        showSubtitle={false}
        title={t('web.studio.swarmOverview')}
      />
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto grid max-w-6xl gap-5 p-4 pb-24 lg:grid-cols-[minmax(0,1fr)_19rem] lg:p-6 lg:pb-24">
          <main className="flex min-w-0 flex-col gap-5">
            <section className="grid gap-5 rounded-xl border border-[color-mix(in_srgb,var(--info)_20%,var(--border))] bg-[color-mix(in_srgb,var(--info)_5%,var(--card))] px-5 py-5 shadow-xs md:grid-cols-[minmax(0,1fr)_17rem] md:items-center">
              <div className="min-w-0">
                <p className="max-w-[72ch] text-muted-foreground text-sm">{t('web.studio.swarmOverviewDesc')}</p>
                <div className="mt-5 flex flex-wrap gap-2">
                  <Button
                    asChild
                    size="sm"
                  >
                    <Link href={studioPath('nativeCliAgents')}>{t('web.studio.connectNativeCli')}</Link>
                  </Button>
                  <Button
                    asChild
                    size="sm"
                    variant="ghost"
                  >
                    <Link href="/">{t('web.studio.openWorkplace')}</Link>
                  </Button>
                </div>
              </div>
              <OverviewIllustration
                className="hidden md:block"
                variant="swarm"
              />
            </section>

            <section className="rounded-xl border bg-card">
              <div className="border-b px-4 py-3">
                <h2 className="font-medium text-base">{t('web.studio.swarmSetupTitle')}</h2>
                <p className="mt-1 text-muted-foreground text-sm">{t('web.studio.swarmSetupDesc')}</p>
              </div>
              <div className="grid gap-1 p-2">
                <SwarmAction
                  body={
                    nativeCliCount > 0
                      ? t('web.studio.nativeCliReady', { count: nativeCliCount })
                      : t('web.studio.nativeCliNeeded')
                  }
                  href={studioPath('nativeCliAgents')}
                  icon={TerminalIcon}
                  title={t('web.studio.nativeCliAgents')}
                />
                <SwarmAction
                  body={
                    frameworkCount > 0
                      ? t('web.studio.frameworkReady', { count: frameworkCount })
                      : t('web.studio.frameworkNeeded')
                  }
                  href={studioPath('frameworkAgents')}
                  icon={Plug01Icon}
                  title={t('web.studio.frameworkAgents')}
                />
                <SwarmAction
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
          </main>

          <aside className="hidden min-w-0 flex-col gap-4 lg:flex">
            <section className="rounded-xl border bg-card px-4 py-4">
              <h2 className="font-medium text-sm">{t('web.studio.swarmBoundaryTitle')}</h2>
              <p className="mt-2 text-muted-foreground text-sm">{t('web.studio.swarmBoundaryDesc')}</p>
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
                <Link href={studioPath('runtime')}>
                  {t('web.studio.openRuntimeOverview')}
                  <HugeiconsIcon icon={ArrowRight01Icon} />
                </Link>
              </Button>
            </section>
          </aside>
        </div>
      </ScrollArea>
    </PanelShell>
  );
}

export function SwarmPlaceholder({ kind }: { kind: 'projects' | 'members' | 'tasks' }) {
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
      body: t('web.studio.swarmTasksPlaceholder')
    }
  }[kind];

  return (
    <PanelShell>
      <StudioBreadcrumbHeader
        showSubtitle={false}
        title={copy.title}
      />
      <ScrollArea className="min-h-0 flex-1">
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
                    <Link href="/">{t('web.studio.openWorkplace')}</Link>
                  </Button>
                  <Button
                    asChild
                    size="sm"
                    variant="ghost"
                  >
                    <Link href={studioPath('swarm')}>{t('web.studio.openSwarmOverview')}</Link>
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </ScrollArea>
    </PanelShell>
  );
}
