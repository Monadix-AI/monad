'use client';

import type { ReactNode } from 'react';

import { ArrowLeft01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button } from '@monad/ui';

import { useT } from '@/components/I18nProvider';
import { ShellLink } from '@/components/ShellLink';
import { PanelShellBreadcrumbHeader } from '@/components/ui/panel-shell';

export function StudioBreadcrumbHeader({
  actions,
  backHref,
  badge,
  icon,
  parentTitle,
  title
}: {
  actions?: ReactNode;
  backHref?: string;
  badge?: ReactNode;
  icon?: ReactNode;
  parentTitle?: ReactNode;
  title: ReactNode;
}) {
  const t = useT();
  const iconSlot = backHref ? (
    <Button
      aria-label={t('web.common.back')}
      asChild
      className="size-7"
      size="icon"
      variant="ghost"
    >
      <ShellLink href={backHref}>
        <HugeiconsIcon icon={ArrowLeft01Icon} />
      </ShellLink>
    </Button>
  ) : icon ? (
    <span className="flex size-7 shrink-0 items-center justify-center text-muted-foreground">{icon}</span>
  ) : undefined;
  return (
    <PanelShellBreadcrumbHeader
      actions={actions}
      badge={badge}
      crumbs={
        parentTitle
          ? [
              { id: 'studio', label: t('web.studio.title') },
              { id: 'parent', label: parentTitle },
              { id: 'current', label: title }
            ]
          : [
              { id: 'studio', label: t('web.studio.title') },
              { id: 'current', label: title }
            ]
      }
      icon={iconSlot}
    />
  );
}
