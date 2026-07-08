'use client';

import type React from 'react';
import type { ReactNode } from 'react';

import { cn } from '@monad/ui';

export function PanelShell({ children, className, ...rest }: React.HTMLAttributes<HTMLElement>) {
  return (
    <section
      {...rest}
      className={cn('flex min-h-0 min-w-0 flex-1 flex-col', className)}
    >
      {children}
    </section>
  );
}

export function PanelShellBody({ children, className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={cn('flex min-h-0 min-w-0 flex-1 flex-col', className)}
    >
      {children}
    </div>
  );
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
    <header
      className={cn(
        'panel-shell-header [.app-main-sidebar-collapsed_&]:!pl-[8.5rem] flex h-[52px] items-center gap-3 border-b bg-muted/20 px-4',
        className
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        {icon}
        <h2 className="min-w-0 font-medium text-sm">{title}</h2>
        {badge}
        {subtitle && <span className="min-w-0 truncate text-muted-foreground text-xs">{subtitle}</span>}
      </div>
      {actions && <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div>}
    </header>
  );
}

export function PanelShellBreadcrumbHeader({
  actions,
  badge,
  className,
  crumbs,
  icon
}: {
  actions?: ReactNode;
  badge?: ReactNode;
  className?: string;
  crumbs: { id: string; label: ReactNode }[];
  icon?: ReactNode;
}) {
  return (
    <PanelShellHeader
      actions={actions}
      badge={badge}
      className={className}
      icon={icon}
      title={
        <span className="inline-flex min-w-0 items-center gap-1.5">
          {crumbs.map((crumb, index) => (
            <span
              className={index === crumbs.length - 1 ? 'truncate' : 'shrink-0'}
              key={crumb.id}
            >
              {index > 0 ? <span className="mr-1.5 text-muted-foreground/70">/</span> : null}
              {crumb.label}
            </span>
          ))}
        </span>
      }
    />
  );
}
