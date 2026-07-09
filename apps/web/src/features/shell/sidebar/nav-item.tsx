'use client';

import type { MouseEvent, ReactNode } from 'react';

import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { cn } from '@monad/ui';

import { ShellLink } from '#/components/ShellLink';

export const SHORTCUT_BADGE_OVERLAY_CLASS = 'pointer-events-none absolute top-1/2 right-1.5 -mt-px -translate-y-1/2';

// Shared hover/selected/disabled state classes for every interactive sidebar row
// (nav items, project rows, the daemon-menu trigger). Callers add their own layout
// classes via cn(); this keeps the tinted surface tokens in exactly one place.
export function sidebarItemStateClass({ active, disabled }: { active?: boolean; disabled?: boolean } = {}): string {
  return cn(
    'text-foreground transition hover:bg-sidebar-accent hover:text-foreground',
    active && 'bg-sidebar-selected text-foreground hover:bg-sidebar-selected-hover',
    disabled && 'cursor-not-allowed text-muted-foreground hover:bg-transparent hover:text-muted-foreground'
  );
}

// Hover-revealed icon action buttons inside a project row (settings, pin).
export function sidebarIconButtonClass({ active }: { active?: boolean } = {}): string {
  return cn(
    'flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-(--radius-sm) text-muted-foreground opacity-0 transition hover:bg-sidebar-accent hover:text-foreground focus-visible:opacity-100 group-focus-within/project-tree:opacity-100 group-hover/project-tree:opacity-100 [@media_(hover:none),_(pointer:coarse)]:opacity-100',
    active && 'text-foreground opacity-100'
  );
}

export function ShortcutBadge({ modifierLabel, value }: { modifierLabel: string; value: number | string }) {
  return (
    <span className="inline-flex h-4 min-w-7 items-center justify-center gap-px rounded-full bg-sidebar-accent/85 px-1.5 font-medium text-[10px] text-muted-foreground tabular-nums shadow-[inset_0_1px_0_rgb(255_255_255/0.08)] backdrop-blur">
      {modifierLabel}
      {value}
    </span>
  );
}

export function SidebarNavSection({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 py-1.5">
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

export function SidebarNavSectionLabel({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pb-1 font-medium text-[11px] text-muted-foreground">{children}</div>;
}

export function SidebarNavItem({
  active,
  children,
  icon: Icon,
  label,
  href,
  onClick,
  disabled,
  disabledReason,
  shortcutModifierLabel,
  shortcutValue
}: {
  active?: boolean;
  children?: ReactNode;
  disabled?: boolean;
  disabledReason?: string;
  href?: string;
  icon: IconSvgElement;
  label: string;
  onClick: () => void;
  shortcutModifierLabel?: string;
  shortcutValue?: number | string;
}) {
  const className = cn(
    'group/item relative flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-(--radius-md) px-2.5 py-2 text-left',
    sidebarItemStateClass({ active, disabled })
  );
  const content = (
    <>
      <div className="rounded-full border border-transparent bg-transparent p-1.5">
        <HugeiconsIcon
          className="size-4"
          icon={Icon}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-normal text-ui leading-control">{label}</div>
        {children}
      </div>
      {shortcutValue && shortcutModifierLabel ? (
        <span className={SHORTCUT_BADGE_OVERLAY_CLASS}>
          <ShortcutBadge
            modifierLabel={shortcutModifierLabel}
            value={shortcutValue}
          />
        </span>
      ) : null}
    </>
  );

  if (href && !disabled) {
    return (
      <ShellLink
        aria-current={active ? 'page' : undefined}
        className={className}
        href={href}
        onClick={(event: MouseEvent<HTMLAnchorElement>) => {
          event.preventDefault();
          onClick();
        }}
        title={disabled ? disabledReason : undefined}
      >
        {content}
      </ShellLink>
    );
  }

  return (
    <button
      aria-current={active ? 'page' : undefined}
      aria-disabled={disabled || undefined}
      className={className}
      onClick={() => {
        if (!disabled) onClick();
      }}
      title={disabled ? disabledReason : undefined}
      type="button"
    >
      {content}
    </button>
  );
}
