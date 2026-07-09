'use client';

import type { ReactNode } from 'react';

import { ChevronDownIcon, ChevronRightIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';

export function WorkspaceSection({
  children,
  collapsed,
  onToggle,
  title
}: {
  children: ReactNode;
  collapsed: boolean;
  onToggle: () => void;
  title: string;
}) {
  return (
    <section className="flex flex-col gap-1">
      <button
        aria-expanded={!collapsed}
        className="flex min-h-7 w-full cursor-pointer items-center gap-1.5 rounded-(--radius-sm) px-2.5 font-medium text-[11px] text-muted-foreground"
        onClick={onToggle}
        title={title}
        type="button"
      >
        <HugeiconsIcon
          className="size-3"
          icon={collapsed ? ChevronRightIcon : ChevronDownIcon}
        />
        <span>{title}</span>
      </button>
      {!collapsed ? <div className="flex flex-col gap-0.5">{children}</div> : null}
    </section>
  );
}
