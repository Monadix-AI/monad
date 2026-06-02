import type { CSSProperties, ReactNode, Ref } from 'react';

import { cn } from '@monad/ui';

const endcapSurfaceStyle = {
  backgroundColor: 'var(--sidebar)',
  backgroundImage: 'linear-gradient(var(--sidebar-item-surface), var(--sidebar-item-surface))'
} satisfies CSSProperties;

const endcapFadeStyle = {
  ...endcapSurfaceStyle,
  maskImage: 'linear-gradient(to right, transparent, black)',
  WebkitMaskImage: 'linear-gradient(to right, transparent, black)'
} satisfies CSSProperties;

export function SidebarItemEndcap({
  children,
  className,
  contentClassName,
  ref
}: {
  children?: ReactNode;
  className?: string;
  contentClassName?: string;
  ref?: Ref<HTMLDivElement>;
}) {
  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-y-0 right-2 z-10 flex w-max max-w-full items-stretch',
        className
      )}
      data-sidebar-item-endcap="true"
      ref={ref}
    >
      <div
        aria-hidden="true"
        className="absolute inset-y-0 right-[calc(100%-0.25rem)] w-6 rounded-l-(--radius-md)"
        data-sidebar-item-endcap-fade="true"
        style={endcapFadeStyle}
      />
      <div
        className={cn('pointer-events-none relative flex w-max shrink-0 items-center gap-0.5', contentClassName)}
        data-sidebar-item-endcap-content="true"
        style={endcapSurfaceStyle}
      >
        {children}
      </div>
    </div>
  );
}
