'use client';

import {
  BotIcon,
  CheckIcon,
  CpuIcon,
  GeometricShapesIcon,
  LinkSquare01Icon,
  PuzzleIcon,
  ShieldHalfIcon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  providerAdapter,
  providerSelectors,
  useListAgentsQuery,
  useListProvidersQuery,
  useListWorkplaceProjectsQuery
} from '@monad/client-rtk';
import { Button } from '@monad/ui';

import { useT } from '#/components/I18nProvider';
import { ShellLink } from '#/components/ShellLink';
import { PanelShell, PanelShellBody } from '#/components/ui/panel-shell';
import { studioPath } from '#/features/routes/route-paths';
import { OverviewIllustration } from './OverviewIllustration';
import { StudioBreadcrumbHeader } from './StudioBreadcrumbHeader';

function readinessState(ready: boolean, loading?: boolean): 'ready' | 'loading' | 'next' {
  if (loading) return 'loading';
  return ready ? 'ready' : 'next';
}

function ReadinessRow({
  actionHref,
  actionLabel,
  body,
  icon,
  state,
  title
}: {
  actionHref: string;
  actionLabel: string;
  body: string;
  icon: typeof CpuIcon;
  state: 'ready' | 'loading' | 'next';
  title: string;
}) {
  const t = useT();
  const ready = state === 'ready';
  return (
    <div className="group/row grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-lg border bg-card px-4 py-3 transition-colors hover:border-ring/30 hover:bg-accent/35 sm:grid-cols-[2.25rem_minmax(0,1fr)_auto] sm:items-center">
      <span className="flex size-9 items-center justify-center rounded-md border bg-background text-muted-foreground group-hover/row:text-foreground">
        <HugeiconsIcon
          className="size-4"
          icon={ready ? CheckIcon : icon}
        />
      </span>
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-sm">{title}</span>
          <span
            className={
              ready
                ? 'rounded-full bg-primary/8 px-2 py-0.5 font-medium text-[11px] text-foreground'
                : 'rounded-full bg-[color-mix(in_srgb,var(--accent-blue)_12%,transparent)] px-2 py-0.5 font-medium text-[11px] text-[color-mix(in_srgb,var(--accent-blue)_68%,var(--foreground))]'
            }
          >
            {ready ? t('web.studio.ready') : state === 'loading' ? t('web.studio.checking') : t('web.studio.nextStep')}
          </span>
        </span>
        <span className="mt-1 block max-w-[64ch] text-muted-foreground text-sm">{body}</span>
      </span>
      <Button
        asChild
        className="col-start-2 justify-self-start sm:col-start-auto"
        size="sm"
        variant={ready ? 'ghost' : 'secondary'}
      >
        <ShellLink href={actionHref}>{actionLabel}</ShellLink>
      </Button>
    </div>
  );
}

function AdvancedLink({
  href,
  icon,
  title,
  body
}: {
  href: string;
  icon: typeof ShieldHalfIcon;
  title: string;
  body: string;
}) {
  return (
    <Button
      asChild
      className="h-auto justify-start border-transparent px-2 py-2 text-left"
      variant="ghost"
    >
      <ShellLink href={href}>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <HugeiconsIcon
            className="size-4"
            icon={icon}
          />
        </span>
        <span className="min-w-0">
          <span className="block font-medium text-sm">{title}</span>
          <span className="block truncate text-muted-foreground text-xs">{body}</span>
        </span>
      </ShellLink>
    </Button>
  );
}

export function RuntimeOverview() {
  const t = useT();
  const providersQuery = useListProvidersQuery(undefined);
  const agentsQuery = useListAgentsQuery();
  const projectsQuery = useListWorkplaceProjectsQuery(undefined);
  const providerCount = providerSelectors.selectAll(providersQuery.data ?? providerAdapter.getInitialState()).length;
  const agentCount = agentsQuery.data?.ids.length ?? 0;
  const hasModels = providerCount > 0;
  const hasAgents = agentCount > 0;
  const projectCount = projectsQuery.data?.projects.ids.length ?? 0;

  return (
    <PanelShell>
      <StudioBreadcrumbHeader title={t('web.studio.runtimeOverview')} />
      <PanelShellBody>
        <div className="mx-auto grid max-w-6xl gap-5 p-4 pb-24 lg:grid-cols-[minmax(0,1fr)_19rem] lg:p-6 lg:pb-24">
          <main className="flex min-w-0 flex-col gap-5">
            <section className="grid gap-5 rounded-xl border bg-card px-5 py-5 shadow-xs md:grid-cols-[minmax(0,1fr)_17rem] md:items-center">
              <div className="min-w-0">
                <p className="max-w-[72ch] text-muted-foreground text-sm">{t('web.studio.runtimeOverviewDesc')}</p>
                <div className="mt-5 flex flex-wrap gap-2">
                  <Button
                    asChild
                    size="sm"
                  >
                    <ShellLink href={studioPath(hasModels ? 'agents' : 'models')}>
                      {t('web.studio.continueSetup')}
                    </ShellLink>
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
              <OverviewIllustration
                className="hidden md:block"
                variant="runtime"
              />
            </section>

            <section className="flex flex-col gap-3">
              <div className="flex items-end justify-between gap-3">
                <div>
                  <h2 className="font-medium text-base">{t('web.studio.runtimeSetupTitle')}</h2>
                  <p className="mt-1 text-muted-foreground text-sm">{t('web.studio.runtimeSetupDesc')}</p>
                </div>
                <span className="hidden rounded-full border px-2.5 py-1 text-muted-foreground text-xs sm:inline-flex">
                  {t('web.studio.progressiveDisclosure')}
                </span>
              </div>
              <ReadinessRow
                actionHref={studioPath('models')}
                actionLabel={hasModels ? t('web.studio.reviewModels') : t('web.studio.connectModel')}
                body={hasModels ? t('web.studio.modelsReady', { count: providerCount }) : t('web.studio.modelsNeeded')}
                icon={CpuIcon}
                state={readinessState(hasModels, providersQuery.isLoading)}
                title={t('web.studio.connectModelStep')}
              />
              <ReadinessRow
                actionHref={studioPath('agents')}
                actionLabel={hasAgents ? t('web.studio.reviewAgents') : t('web.studio.createAgentAction')}
                body={hasAgents ? t('web.studio.agentsReady', { count: agentCount }) : t('web.studio.agentsNeeded')}
                icon={BotIcon}
                state={readinessState(hasAgents, agentsQuery.isLoading)}
                title={t('web.studio.chooseAgentStep')}
              />
              <ReadinessRow
                actionHref={studioPath('capabilities')}
                actionLabel={t('web.studio.reviewRuntime')}
                body={t('web.studio.capabilitiesNeeded')}
                icon={GeometricShapesIcon}
                state="next"
                title={t('web.studio.enableToolsStep')}
              />
            </section>

            <details className="group rounded-xl border bg-card">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-xl px-4 py-3 outline-none transition-colors hover:bg-accent/35 focus-visible:ring-2 focus-visible:ring-ring/40">
                <span>
                  <span className="block font-medium text-sm">{t('web.studio.advancedRuntimeSettings')}</span>
                  <span className="mt-0.5 block text-muted-foreground text-xs">
                    {t('web.studio.advancedRuntimeSettingsDesc')}
                  </span>
                </span>
                <span className="text-muted-foreground text-xs group-open:hidden">{t('web.studio.showAdvanced')}</span>
                <span className="hidden text-muted-foreground text-xs group-open:inline">
                  {t('web.studio.hideAdvanced')}
                </span>
              </summary>
              <div className="grid gap-1 border-t p-2 sm:grid-cols-2">
                <AdvancedLink
                  body={t('web.studio.capabilitiesShortDesc')}
                  href={studioPath('capabilities')}
                  icon={GeometricShapesIcon}
                  title={t('web.studio.capabilities')}
                />
                <AdvancedLink
                  body={t('web.studio.acpDelegatesShortDesc')}
                  href={studioPath('acpDelegates')}
                  icon={PuzzleIcon}
                  title={t('web.studio.acpDelegates')}
                />
                <AdvancedLink
                  body={t('web.studio.memoryShortDesc')}
                  href={studioPath('memory')}
                  icon={LinkSquare01Icon}
                  title={t('web.settings.memory')}
                />
                <AdvancedLink
                  body={t('web.studio.safetyShortDesc')}
                  href={studioPath('safety')}
                  icon={ShieldHalfIcon}
                  title={t('web.studio.safetyAndHooks')}
                />
              </div>
            </details>
          </main>

          <aside className="hidden min-w-0 flex-col gap-4 lg:flex">
            <section className="rounded-xl border border-[color-mix(in_srgb,var(--info)_22%,var(--border))] bg-[color-mix(in_srgb,var(--info)_7%,var(--card))] px-4 py-4">
              <h2 className="font-medium text-sm">{t('web.studio.whenYouNeedTeam')}</h2>
              <p className="mt-2 text-muted-foreground text-sm">{t('web.studio.meshBridgeDesc')}</p>
              <Button
                asChild
                className="mt-4"
                size="sm"
                variant="secondary"
              >
                <ShellLink href={studioPath('mesh')}>{t('web.studio.openMeshOverview')}</ShellLink>
              </Button>
            </section>
            <section className="rounded-xl border bg-card px-4 py-4">
              <h2 className="font-medium text-sm">{t('web.studio.boundaryTitle')}</h2>
              <p className="mt-2 text-muted-foreground text-sm">{t('web.studio.runtimeBoundaryDesc')}</p>
              <p className="mt-3 text-muted-foreground text-xs">
                {projectCount > 0
                  ? t('web.studio.projectsAvailable', { count: projectCount })
                  : t('web.studio.noProjectsYet')}
              </p>
            </section>
          </aside>
        </div>
      </PanelShellBody>
    </PanelShell>
  );
}
