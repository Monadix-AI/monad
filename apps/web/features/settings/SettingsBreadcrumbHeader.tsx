'use client';

import type { ReactNode } from 'react';

import { Cancel01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button } from '@monad/ui';

import { useT } from '@/components/I18nProvider';
import { PanelShellBreadcrumbHeader } from '@/components/ui/panel-shell';

export function SettingsBreadcrumbHeader({
  badge,
  icon,
  onClose,
  title
}: {
  badge?: ReactNode;
  icon?: ReactNode;
  onClose: () => void;
  title: ReactNode;
}) {
  const t = useT();
  return (
    <PanelShellBreadcrumbHeader
      actions={
        <Button
          aria-label={t('web.close')}
          className="size-7"
          onClick={onClose}
          size="icon"
          variant="ghost"
        >
          <HugeiconsIcon icon={Cancel01Icon} />
        </Button>
      }
      badge={badge}
      className="px-6"
      crumbs={[
        { id: 'settings', label: t('web.settings.title') },
        { id: 'current', label: title }
      ]}
      icon={
        icon ? (
          <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">{icon}</span>
        ) : undefined
      }
    />
  );
}
