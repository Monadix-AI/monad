import type { ComponentPropsWithoutRef } from 'react';

import { cn } from '@monad/ui';

export const hoverActionsVisibleClassName = 'pointer-events-auto opacity-100';

export const hoverActionsClassName =
  'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 [@media_(hover:none),_(pointer:coarse)]:pointer-events-auto [@media_(hover:none),_(pointer:coarse)]:opacity-100';

export const profileCardHoverActionsClassName =
  'pointer-events-none opacity-0 group-hover/profile-card:pointer-events-auto group-hover/profile-card:opacity-100 group-focus-within/profile-card:pointer-events-auto group-focus-within/profile-card:opacity-100 [@media_(hover:none),_(pointer:coarse)]:pointer-events-auto [@media_(hover:none),_(pointer:coarse)]:opacity-100';

export function HoverActions({
  className,
  visible = false,
  ...props
}: ComponentPropsWithoutRef<'div'> & { visible?: boolean }) {
  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-0.5 transition-opacity',
        visible ? hoverActionsVisibleClassName : hoverActionsClassName,
        className
      )}
      {...props}
    />
  );
}

export function ProfileCardHoverActions({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-0.5 transition-opacity',
        profileCardHoverActionsClassName,
        className
      )}
      {...props}
    />
  );
}
