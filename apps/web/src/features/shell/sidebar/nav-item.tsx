import type { MouseEvent, ReactNode } from 'react';

import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { cn, ShortcutChip, Tooltip, TooltipContent, TooltipTrigger } from '@monad/ui';
import { Children } from 'react';

import { ShellLink } from '#/components/ShellLink';
import { SidebarItemEndcap } from './sidebar-item-endcap';

const SIDEBAR_ITEM_HEIGHT_CLASS = 'h-token-sidebar-row';
const SIDEBAR_ITEM_PADDING_CLASS = 'px-row-x';
export const SIDEBAR_ITEM_LABEL_CLASS = 'min-w-0 flex-1 truncate';
export const SIDEBAR_ITEM_ROW_CLASS = `${SIDEBAR_ITEM_HEIGHT_CLASS} ${SIDEBAR_ITEM_PADDING_CLASS}`;
export const SIDEBAR_INDENTED_ITEM_ROW_CLASS = `${SIDEBAR_ITEM_HEIGHT_CLASS} pr-row-x pl-5`;
const SIDEBAR_ITEM_TEXT_CLASS = 'text-foreground hover:text-foreground';
export const SIDEBAR_SECONDARY_TEXT_CLASS = 'text-muted-foreground/75 hover:text-muted-foreground';
export const SIDEBAR_SECTION_TITLE_CLASS = `px-row-x pb-1 font-normal ${SIDEBAR_SECONDARY_TEXT_CLASS} text-[13px] leading-control`;

export function sidebarItemSurfaceClass({
  active,
  interactive = true
}: {
  active?: boolean;
  interactive?: boolean;
} = {}): string {
  return cn(
    '[--sidebar-item-surface:var(--sidebar)]',
    interactive && 'hover:[--sidebar-item-surface:var(--sidebar-accent)]',
    active && '[--sidebar-item-surface:var(--sidebar-selected)]',
    active && interactive && 'hover:[--sidebar-item-surface:var(--sidebar-selected-hover)]'
  );
}

// Shared hover/selected/disabled state classes for every interactive sidebar row
// (nav items, project rows, the daemon-menu trigger). Callers add their own layout
// classes via cn(); this keeps the tinted surface tokens in exactly one place.
export function sidebarItemStateClass({ active, disabled }: { active?: boolean; disabled?: boolean } = {}): string {
  return cn(
    'font-normal text-[13px] leading-control transition hover:bg-sidebar-accent',
    SIDEBAR_ITEM_TEXT_CLASS,
    active && 'bg-sidebar-selected hover:bg-sidebar-selected-hover',
    disabled && 'cursor-not-allowed text-muted-foreground hover:bg-transparent hover:text-muted-foreground'
  );
}

export function sidebarItemContainerClass({
  active,
  className,
  disabled
}: {
  active?: boolean;
  className?: string;
  disabled?: boolean;
} = {}): string {
  return cn(
    'relative flex w-full min-w-0 max-w-full items-center overflow-hidden rounded-(--radius-md) text-left',
    sidebarItemSurfaceClass({ active, interactive: !disabled }),
    sidebarItemStateClass({ active, disabled }),
    'bg-[var(--sidebar-item-surface)] hover:bg-[var(--sidebar-item-surface)]',
    className
  );
}

// Hover-revealed icon action buttons inside sidebar rows. Touch devices keep them visible.
export function sidebarIconButtonClass({ active }: { active?: boolean } = {}): string {
  return cn(
    'sidebar-item-action pointer-events-auto flex size-6 shrink-0 items-center justify-center rounded-(--radius-md) text-muted-foreground opacity-0 transition hover:bg-sidebar-accent hover:text-foreground [@media_(hover:none),_(pointer:coarse)]:opacity-100',
    active && 'text-foreground'
  );
}

export function SidebarIconActionButton({
  active,
  className,
  icon,
  iconClassName,
  label,
  onClick,
  tooltip = label
}: {
  active?: boolean;
  className?: string;
  icon: IconSvgElement;
  iconClassName?: string;
  label: string;
  onClick: () => void;
  tooltip?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={label}
          className={cn(sidebarIconButtonClass({ active }), className)}
          onClick={onClick}
          title={tooltip}
          type="button"
        >
          <HugeiconsIcon
            className={cn('size-3.5', iconClassName)}
            icon={icon}
          />
        </button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

export function SidebarActionVisibilityRules() {
  return (
    <style>{`
      [data-sidebar-tree-item="true"][data-sidebar-actions-visible="true"] > .sidebar-item-action,
      [data-sidebar-tree-item="true"][data-sidebar-actions-visible="true"] [data-sidebar-session-actions="true"] > .sidebar-item-action,
      [data-sidebar-tree-item="true"]:hover [data-sidebar-session-actions="true"] > .sidebar-item-action,
      [data-sidebar-tree-item="true"] > .sidebar-item-action[data-state="open"],
      [data-sidebar-section-item="true"]:hover [data-sidebar-item-endcap-content="true"] > .sidebar-item-action,
      [data-sidebar-section-item="true"]:has(:focus-visible) [data-sidebar-item-endcap-content="true"] > .sidebar-item-action {
        opacity: 1;
        visibility: visible;
      }
      [data-sidebar-tree-item="true"] [data-sidebar-session-actions="true"] > .sidebar-item-action[data-state="open"] {
        opacity: 1;
      }
      [data-sidebar-tree-item="true"][data-sidebar-actions-visible="true"] > [data-sidebar-item-endcap="true"] {
        pointer-events: auto;
      }
      [data-sidebar-tree-item="true"]:hover > [data-sidebar-item-endcap="true"] {
        pointer-events: auto;
      }
      [data-sidebar-item-endcap="true"] {
        opacity: 1;
      }
    `}</style>
  );
}

function SidebarShortcutBadge({ modifierLabel, value }: { modifierLabel: string; value: number | string }) {
  return (
    <ShortcutChip>
      {modifierLabel}
      {value}
    </ShortcutChip>
  );
}

export function SidebarNavSection({ children }: { children: ReactNode }) {
  return (
    <div className="mt-2 px-2 py-1.5 first:mt-0">
      <div className="flex flex-col gap-px">{children}</div>
    </div>
  );
}

export function SidebarNavSectionLabel({ children }: { children: ReactNode }) {
  return <div className={SIDEBAR_SECTION_TITLE_CLASS}>{children}</div>;
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
  const hasEndcapContent = Children.toArray(children).length > 0;
  const shortcutBadge =
    shortcutValue && shortcutModifierLabel ? (
      <SidebarShortcutBadge
        modifierLabel={shortcutModifierLabel}
        value={shortcutValue}
      />
    ) : null;
  const className = cn(
    'group/item',
    sidebarItemContainerClass({
      active,
      className: cn(SIDEBAR_ITEM_ROW_CLASS, 'gap-1.5'),
      disabled
    })
  );
  const content = (
    <>
      <div className="flex size-5 shrink-0 items-center justify-center">
        <HugeiconsIcon
          className="size-3.5"
          icon={Icon}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate">{label}</div>
      </div>
      {hasEndcapContent || shortcutBadge ? <SidebarItemEndcap>{shortcutBadge ?? children}</SidebarItemEndcap> : null}
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
