import { Skeleton } from '@monad/ui';

const SIDEBAR_SKELETON_KEYS = ['one', 'two', 'three', 'four', 'five'];

function SidebarItemSkeleton({ indent = false }: { indent?: boolean }) {
  return (
    <div className="flex min-h-8 items-center gap-2 px-2 py-1.5">
      <Skeleton className="size-3.5 shrink-0 rounded-(--radius-xs)" />
      <Skeleton className={indent ? 'ml-3 h-3.5 w-[58%]' : 'h-3.5 w-[68%]'} />
      <Skeleton className="ml-auto size-3.5 shrink-0 rounded-(--radius-xs)" />
    </div>
  );
}

export function SidebarItemSkeletonList({ count = 5, indent = false }: { count?: number; indent?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      {SIDEBAR_SKELETON_KEYS.slice(0, count).map((key, index) => (
        <SidebarItemSkeleton
          indent={indent && index > 0}
          key={key}
        />
      ))}
    </div>
  );
}
