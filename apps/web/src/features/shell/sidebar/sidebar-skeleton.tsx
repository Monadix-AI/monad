import { Skeleton } from '@monad/ui';

const SIDEBAR_SKELETON_KEYS = ['one', 'two', 'three', 'four', 'five'];

function SidebarItemSkeleton({ indent = false }: { indent?: boolean }) {
  return (
    <div className="flex h-token-sidebar-row items-center gap-2 px-row-x">
      <Skeleton className="size-3.5 shrink-0 rounded-(--radius-xs)" />
      <Skeleton className={indent ? 'ml-3 h-3.5 w-[58%]' : 'h-3.5 w-[68%]'} />
      <Skeleton className="ml-auto size-3.5 shrink-0 rounded-(--radius-xs)" />
    </div>
  );
}

export function SidebarItemSkeletonList({ count = 5, indent = false }: { count?: number; indent?: boolean }) {
  return (
    <div className="flex flex-col gap-px">
      {SIDEBAR_SKELETON_KEYS.slice(0, count).map((key, index) => (
        <SidebarItemSkeleton
          indent={indent && index > 0}
          key={key}
        />
      ))}
    </div>
  );
}
