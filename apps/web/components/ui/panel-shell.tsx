'use client';

import type { ReactNode } from 'react';

import { cn } from '@monad/ui';

export function PanelShell({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cn('flex min-h-0 min-w-0 flex-1 flex-col', className)}>{children}</section>;
}

interface PanelShellHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  badge?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function PanelShellHeader({ title, subtitle, badge, icon, actions, className }: PanelShellHeaderProps) {
  return (
    <header className={cn('flex items-center gap-3 border-b bg-muted/20 px-4 py-2.5', className)}>
      {icon}
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <h2 className="shrink-0 font-medium text-sm">{title}</h2>
        {badge}
        {subtitle && <span className="min-w-0 truncate text-muted-foreground text-xs">{subtitle}</span>}
      </div>
      {actions && <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div>}
    </header>
  );
}
