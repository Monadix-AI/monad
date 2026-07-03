'use client';

import type { ReactNode } from 'react';

import { ArrowLeft01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button } from '@monad/ui';
import Link from 'next/link';

import { useT } from '@/components/I18nProvider';
import { PanelShellHeader } from '@/components/ui/panel-shell';

export function StudioBreadcrumbHeader({
  actions,
  backHref,
  badge,
  icon,
  parentTitle,
  showSubtitle = true,
  title
}: {
  actions?: ReactNode;
  backHref?: string;
  badge?: ReactNode;
  icon?: ReactNode;
  parentTitle?: ReactNode;
  showSubtitle?: boolean;
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
      <Link href={backHref}>
        <HugeiconsIcon icon={ArrowLeft01Icon} />
      </Link>
    </Button>
  ) : icon ? (
    <span className="flex size-7 shrink-0 items-center justify-center text-muted-foreground">{icon}</span>
  ) : undefined;
  const mainTitle = parentTitle ? (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="shrink-0">{parentTitle}</span>
      <span className="text-muted-foreground/70">/</span>
      <span className="truncate">{title}</span>
    </span>
  ) : (
    title
  );
  const subtitle =
    parentTitle || !showSubtitle ? undefined : (
      <span className="inline-flex min-w-0 items-center gap-1">
        <span>{t('web.studio.title')}</span>
        <span className="text-muted-foreground/70">/</span>
        <span className="truncate">{title}</span>
      </span>
    );
  return (
    <PanelShellHeader
      actions={actions}
      badge={badge}
      icon={iconSlot}
      subtitle={subtitle}
      title={mainTitle}
    />
  );
}
