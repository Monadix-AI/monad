'use client';

import { ShieldHalfIcon, WorkflowSquare01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button, ScrollArea } from '@monad/ui';

import { useT } from '@/components/I18nProvider';
import { ShellLink } from '@/components/ShellLink';
import { PanelShell } from '@/components/ui/panel-shell';
import { studioPath } from '@/features/routes/route-paths';
import { StudioBreadcrumbHeader } from './StudioBreadcrumbHeader';

function SafetyLink({ href, title, body }: { href: string; title: string; body: string }) {
  return (
    <Button
      asChild
      className="h-auto justify-start px-3 py-3 text-left"
      variant="ghost"
    >
      <ShellLink href={href}>
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground">
          <HugeiconsIcon
            className="size-4"
            icon={ShieldHalfIcon}
          />
        </span>
        <span className="min-w-0">
          <span className="block font-medium text-sm">{title}</span>
          <span className="mt-1 block max-w-[56ch] text-muted-foreground text-xs">{body}</span>
        </span>
      </ShellLink>
    </Button>
  );
}

export function SafetyAndHooks() {
  const t = useT();
  return (
    <PanelShell>
      <StudioBreadcrumbHeader title={t('web.studio.safetyAndHooks')} />
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto grid max-w-5xl gap-5 p-4 pb-24 lg:grid-cols-[minmax(0,1fr)_18rem] lg:p-6 lg:pb-24">
          <main className="rounded-xl border bg-card">
            <div className="border-b px-5 py-5">
              <h2 className="font-medium text-base">{t('web.studio.safetyAndHooksTitle')}</h2>
              <p className="mt-2 max-w-[72ch] text-muted-foreground text-sm">{t('web.studio.safetyAndHooksDesc')}</p>
            </div>
            <div className="grid gap-1 p-2">
              <SafetyLink
                body={t('web.studio.approvalsDesc')}
                href={studioPath('approvals')}
                title={t('web.settings.approvals')}
              />
              <SafetyLink
                body={t('web.studio.sandboxDesc')}
                href={studioPath('sandbox')}
                title={t('web.studio.sandbox')}
              />
              <SafetyLink
                body={t('web.studio.hooksDesc')}
                href={studioPath('hooks')}
                title={t('web.studio.hooks')}
              />
            </div>
          </main>
          <aside className="hidden rounded-xl border bg-card px-4 py-4 lg:block">
            <span className="flex size-9 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <HugeiconsIcon
                className="size-4"
                icon={WorkflowSquare01Icon}
              />
            </span>
            <h2 className="mt-3 font-medium text-sm">{t('web.studio.safetyBoundaryTitle')}</h2>
            <p className="mt-2 text-muted-foreground text-sm">{t('web.studio.safetyBoundaryDesc')}</p>
          </aside>
        </div>
      </ScrollArea>
    </PanelShell>
  );
}
