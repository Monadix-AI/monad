'use client';

import type { ReactNode } from 'react';

import { Button } from '@monad/ui';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';

import { useT } from '@/components/I18nProvider';
import { PanelShellHeader } from '@/components/ui/panel-shell';

export function StudioBreadcrumbHeader({
  actions,
  backHref,
  icon,
  parentTitle,
  title
}: {
  actions?: ReactNode;
  backHref?: string;
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
      <Link href={backHref}>
        <ArrowLeft />
      </Link>
    </Button>
  ) : (
    icon
  );
  const mainTitle = parentTitle ? (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="shrink-0">{parentTitle}</span>
      <span className="text-muted-foreground/70">/</span>
      <span className="truncate">{title}</span>
    </span>
  ) : (
    title
  );
  const subtitle = parentTitle ? undefined : (
    <span className="inline-flex min-w-0 items-center gap-1">
      <span>{t('web.studio.title')}</span>
      <span className="text-muted-foreground/70">/</span>
      <span className="truncate">{title}</span>
    </span>
  );
  return (
    <PanelShellHeader
      actions={actions}
      icon={iconSlot}
      subtitle={subtitle}
      title={mainTitle}
    />
  );
}
