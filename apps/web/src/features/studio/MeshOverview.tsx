import { BotIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button } from '@monad/ui';

import { useT } from '#/components/I18nProvider';
import { ShellLink } from '#/components/ShellLink';
import { PanelShell, PanelShellBody } from '#/components/ui/panel-shell';
import { studioPath } from '#/features/shell/routing/paths';
import { MeshUsage } from './MeshUsage';
import { StudioBreadcrumbHeader } from './StudioBreadcrumbHeader';

export function MeshOverview() {
  const t = useT();

  return (
    <PanelShell>
      <StudioBreadcrumbHeader title={t('web.studio.meshOverview')} />
      <PanelShellBody className="overflow-y-auto">
        <div className="mx-auto grid max-w-5xl gap-5 p-4 pb-24 lg:p-6 lg:pb-24">
          <main className="flex min-w-0 flex-col gap-5">
            <MeshUsage />
          </main>
        </div>
      </PanelShellBody>
    </PanelShell>
  );
}

export function MeshPlaceholder({ kind }: { kind: 'members' | 'tasks' }) {
  const t = useT();
  const copy = {
    members: {
      title: t('web.studio.projectMembers'),
      body: t('web.studio.projectMembersPlaceholder')
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
