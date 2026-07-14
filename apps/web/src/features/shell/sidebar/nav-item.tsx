import type { MouseEvent, ReactNode } from 'react';

import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { cn, Tooltip, TooltipContent, TooltipTrigger } from '@monad/ui';

import { ShellLink } from '#/components/ShellLink';

export const SHORTCUT_BADGE_OVERLAY_CLASS = 'pointer-events-none absolute top-1/2 right-1.5 -mt-px -translate-y-1/2';
const SIDEBAR_ITEM_HEIGHT_CLASS = 'min-h-8';
const SIDEBAR_ITEM_PADDING_CLASS = 'px-2 py-1.5';
export const SIDEBAR_ITEM_LABEL_CLASS = 'min-w-0 flex-1 truncate';
export const SIDEBAR_ITEM_ROW_CLASS = `${SIDEBAR_ITEM_HEIGHT_CLASS} ${SIDEBAR_ITEM_PADDING_CLASS}`;
export const SIDEBAR_ITEM_FOCUS_CLASS = 'focus-visible:bg-sidebar-accent focus-visible:outline-none';
export const SIDEBAR_INDENTED_ITEM_ROW_CLASS = `${SIDEBAR_ITEM_HEIGHT_CLASS} py-1.5 pr-2 pl-5`;
const SIDEBAR_ITEM_TEXT_CLASS = 'text-foreground hover:text-foreground';
export const SIDEBAR_SECONDARY_TEXT_CLASS = 'text-muted-foreground/75 hover:text-muted-foreground';
export const SIDEBAR_SECTION_TITLE_CLASS = `px-2 pb-1 font-normal ${SIDEBAR_SECONDARY_TEXT_CLASS} text-ui leading-control`;

// Shared hover/selected/disabled state classes for every interactive sidebar row
// (nav items, project rows, the daemon-menu trigger). Callers add their own layout
// classes via cn(); this keeps the tinted surface tokens in exactly one place.
export function sidebarItemStateClass({ active, disabled }: { active?: boolean; disabled?: boolean } = {}): string {
  return cn(
    'font-normal text-ui leading-control transition hover:bg-sidebar-accent',
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
    'relative flex w-full items-center rounded-(--radius-md) text-left',
    sidebarItemStateClass({ active, disabled }),
    className
  );
}

// Hover-revealed icon action buttons inside sidebar rows. Touch devices keep them visible.
export function sidebarIconButtonClass({ active }: { active?: boolean } = {}): string {
  return cn(
    'sidebar-item-action flex size-5.5 shrink-0 items-center justify-center rounded-(--radius-sm) text-muted-foreground opacity-0 transition hover:bg-sidebar-accent hover:text-foreground [@media_(hover:none),_(pointer:coarse)]:opacity-100',
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
      [data-sidebar-tree-item="true"]:hover > .sidebar-item-action,
      [data-sidebar-tree-item="true"] > .sidebar-item-action[data-state="open"] {
        opacity: 1;
      }
    `}</style>
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
    <div className="mt-2 px-2 py-1.5 first:mt-0">
      <div className="flex flex-col gap-0.5">{children}</div>
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
  const className = cn(
    'group/item',
    sidebarItemContainerClass({
      active,
      className: cn(SIDEBAR_ITEM_ROW_CLASS, 'gap-2'),
      disabled
    })
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
        <div className="truncate">{label}</div>
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
