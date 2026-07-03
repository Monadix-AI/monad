'use client';

import type { Session } from '@monad/protocol';
import type { CSSProperties, PointerEvent } from 'react';

import {
  ArrowRight01Icon,
  BoxesIcon,
  MessageSquareCodeIcon,
  PlusSignIcon,
  Settings02Icon,
  Shield01Icon,
  SlidersHorizontalIcon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button } from '@monad/ui';

import { useT } from '@/components/I18nProvider';
import { MonadLogo } from '@/components/MonadLogo';
import { ThemeToggle } from '@/components/ThemeToggle';

interface WorkspaceHomeProps {
  agentSession: Session | null;
  projects: { id: string; name: string }[];
  activeProjectId: string | null;
  onOpenAgentChat: () => void;
  onNewAgentChat: () => void;
  onOpenProject: (projectId: string) => void;
  onNewProject: () => void;
  onOpenSettings: () => void;
  onOpenStudio: () => void;
}

type WorkspaceHomeStyle = CSSProperties & {
  '--workspace-home-spotlight-x': string;
  '--workspace-home-spotlight-y': string;
};

export function WorkspaceHome({
  agentSession,
  projects,
  activeProjectId,
  onOpenAgentChat,
  onNewAgentChat,
  onOpenProject,
  onNewProject,
  onOpenSettings,
  onOpenStudio
}: WorkspaceHomeProps) {
  const t = useT();
  const latestTitle = agentSession?.title ?? t('web.workspace.noAgentSession');
  const homeStyle: WorkspaceHomeStyle = {
    '--workspace-home-spotlight-x': '58%',
    '--workspace-home-spotlight-y': '24%'
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.style.setProperty('--workspace-home-spotlight-x', `${event.clientX - rect.left}px`);
    event.currentTarget.style.setProperty('--workspace-home-spotlight-y', `${event.clientY - rect.top}px`);
  };

  const handlePointerLeave = (event: PointerEvent<HTMLDivElement>): void => {
    event.currentTarget.style.setProperty('--workspace-home-spotlight-x', '58%');
    event.currentTarget.style.setProperty('--workspace-home-spotlight-y', '24%');
  };

  return (
    <div
      className="workspace-home-shell flex min-h-0 flex-1 flex-col bg-background"
      onPointerLeave={handlePointerLeave}
      onPointerMove={handlePointerMove}
      style={homeStyle}
    >
      <div
        aria-hidden="true"
        className="workspace-home-background"
      />
      <header className="relative z-10 flex h-14 shrink-0 items-center justify-between border-border border-b px-5 sm:px-8">
        <button
          className="flex cursor-pointer items-center gap-2 text-left"
          onClick={onOpenAgentChat}
          type="button"
        >
          <MonadLogo className="h-5 w-[4.375rem] text-foreground" />
        </button>
        <div className="flex items-center gap-1">
          <Button
            className="hidden sm:inline-flex"
            onClick={onOpenStudio}
            size="sm"
            variant="ghost"
          >
            <HugeiconsIcon
              data-icon="inline-start"
              icon={SlidersHorizontalIcon}
            />
            {t('web.studio.title')}
          </Button>
          <Button
            className="hidden sm:inline-flex"
            onClick={onOpenSettings}
            size="sm"
            variant="ghost"
          >
            <HugeiconsIcon
              data-icon="inline-start"
              icon={Settings02Icon}
            />
            {t('web.sidebar.settings')}
          </Button>
          <ThemeToggle />
        </div>
      </header>

      <div className="relative z-10 min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-5 py-8 sm:px-8 lg:py-10">
          <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-end">
            <div className="flex flex-col gap-4">
              <h1 className="max-w-3xl text-balance font-semibold text-4xl text-foreground tracking-normal sm:text-5xl">
                {t('web.workspace.title')}
              </h1>
              <p className="max-w-2xl text-muted-foreground text-sm leading-6 sm:text-base">
                {t('web.workspace.summary')}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button onClick={onOpenAgentChat}>
                  <HugeiconsIcon
                    data-icon="inline-start"
                    icon={MessageSquareCodeIcon}
                  />
                  {t('web.workspace.openAgent')}
                </Button>
                <Button
                  onClick={onNewAgentChat}
                  variant="outline"
                >
                  <HugeiconsIcon
                    data-icon="inline-start"
                    icon={PlusSignIcon}
                  />
                  {t('web.workspace.newAgentSession')}
                </Button>
                <Button
                  onClick={onNewProject}
                  variant="outline"
                >
                  <HugeiconsIcon
                    data-icon="inline-start"
                    icon={PlusSignIcon}
                  />
                  {t('web.workplace.newProject')}
                </Button>
              </div>
            </div>
            <div className="rounded-lg border border-border bg-muted/40 px-4 py-4">
              <div className="flex items-center gap-2 text-muted-foreground text-xs">
                <HugeiconsIcon
                  className="size-4 text-link"
                  icon={Shield01Icon}
                />
                <span>{t('web.workspace.localDaemon')}</span>
              </div>
              <div className="mt-3 text-muted-foreground text-xs">{t('web.workspace.latestSession')}</div>
              <div className="mt-1 line-clamp-2 font-medium text-foreground text-sm">{latestTitle}</div>
            </div>
          </section>

          <section className="grid gap-4 lg:grid-cols-[minmax(20rem,0.8fr)_minmax(0,1.2fr)]">
            <article className="flex flex-col justify-between gap-6 rounded-lg border border-border bg-card px-5 py-5">
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="grid size-9 place-items-center rounded-md border border-border bg-muted text-foreground">
                      <HugeiconsIcon
                        className="size-4"
                        icon={MessageSquareCodeIcon}
                      />
                    </span>
                    <h2 className="font-semibold text-base text-foreground">{t('web.workspace.agentTitle')}</h2>
                  </div>
                  <span className="rounded-full bg-accent px-2.5 py-1 font-medium text-accent-foreground text-xs">
                    {t('web.workspace.agentLabel')}
                  </span>
                </div>
                <p className="text-muted-foreground text-sm leading-6">{t('web.workspace.agentSummary')}</p>
              </div>
              <div className="rounded-md border border-border bg-muted/35 px-3 py-3">
                <div className="text-muted-foreground text-xs">{t('web.workspace.latestSession')}</div>
                <div className="mt-1 line-clamp-1 font-medium text-foreground text-sm">{latestTitle}</div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={onOpenAgentChat}
                  size="sm"
                >
                  {t('web.workspace.openAgent')}
                  <HugeiconsIcon
                    data-icon="inline-end"
                    icon={ArrowRight01Icon}
                  />
                </Button>
                <Button
                  onClick={onNewAgentChat}
                  size="sm"
                  variant="outline"
                >
                  <HugeiconsIcon
                    data-icon="inline-start"
                    icon={PlusSignIcon}
                  />
                  {t('web.workspace.newAgentSession')}
                </Button>
              </div>
            </article>

            <section className="rounded-lg border border-border bg-card">
              <div className="flex items-center justify-between gap-3 border-border border-b px-5 py-4">
                <div>
                  <h2 className="font-semibold text-base text-foreground">{t('web.workplace.projectsTitle')}</h2>
                  <p className="mt-1 text-muted-foreground text-sm">{t('web.workplace.projectsLabel')}</p>
                </div>
                <Button
                  onClick={onNewProject}
                  size="sm"
                  variant="outline"
                >
                  <HugeiconsIcon
                    data-icon="inline-start"
                    icon={PlusSignIcon}
                  />
                  {t('web.workplace.newProject')}
                </Button>
              </div>
              {projects.length === 0 ? (
                <div className="flex min-h-56 flex-col items-start justify-center gap-3 px-5 py-8">
                  <span className="grid size-10 place-items-center rounded-md border border-border bg-muted text-muted-foreground">
                    <HugeiconsIcon
                      className="size-5"
                      icon={BoxesIcon}
                    />
                  </span>
                  <div>
                    <div className="font-medium text-foreground text-sm">{t('web.workplace.noProjects')}</div>
                    <p className="mt-1 text-muted-foreground text-sm">{t('web.workplace.noProjectsHint')}</p>
                  </div>
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {projects.map((project) => (
                    <li
                      aria-current={activeProjectId === project.id ? 'page' : undefined}
                      key={project.id}
                    >
                      <button
                        className="flex w-full cursor-pointer items-center justify-between gap-4 px-5 py-4 text-left transition hover:bg-accent/70"
                        onClick={() => onOpenProject(project.id)}
                        type="button"
                      >
                        <div className="min-w-0">
                          <div className="font-medium text-foreground text-sm">{project.name}</div>
                          <p className="mt-1 line-clamp-1 text-muted-foreground text-sm">
                            {t('web.workplace.projectSummary')}
                          </p>
                        </div>
                        <HugeiconsIcon
                          className="size-4 shrink-0 text-muted-foreground"
                          icon={ArrowRight01Icon}
                        />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </section>

          <section className="grid gap-3 md:grid-cols-3">
            <button
              className="rounded-lg border border-border bg-card px-4 py-4 text-left transition hover:bg-muted"
              onClick={onOpenSettings}
              type="button"
            >
              <HugeiconsIcon
                className="size-4 text-muted-foreground"
                icon={Settings02Icon}
              />
              <div className="mt-3 font-medium text-foreground text-sm">{t('web.sidebar.settings')}</div>
              <p className="mt-1 text-muted-foreground text-sm">{t('web.workspace.settingsSummary')}</p>
            </button>
            <Button
              className="h-auto justify-start rounded-lg border-border bg-card px-4 py-4 text-left text-foreground hover:bg-muted"
              onClick={onOpenStudio}
              variant="outline"
            >
              <span>
                <HugeiconsIcon
                  className="size-4 text-muted-foreground"
                  icon={SlidersHorizontalIcon}
                />
                <span className="mt-3 block font-medium text-sm">{t('web.studio.title')}</span>
                <span className="mt-1 block text-muted-foreground text-sm">{t('web.workspace.studioSummary')}</span>
              </span>
            </Button>
            <div className="rounded-lg border border-border bg-muted/35 px-4 py-4">
              <HugeiconsIcon
                className="size-4 text-link"
                icon={Shield01Icon}
              />
              <div className="mt-3 font-medium text-foreground text-sm">{t('web.workspace.localDaemon')}</div>
              <p className="mt-1 text-muted-foreground text-sm">{t('web.workspace.localDaemonSummary')}</p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
