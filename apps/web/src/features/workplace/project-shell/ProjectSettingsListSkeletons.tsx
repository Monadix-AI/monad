import { Skeleton } from '@monad/ui';

function SkeletonRow({ actions, avatarSize }: { actions: number; avatarSize: 30 | 34 }): React.ReactElement {
  return (
    <div className="grid grid-cols-[34px_minmax(0,1fr)_auto] items-center gap-2.5 border-t px-3 py-2.5 first:border-t-0">
      <Skeleton
        className="rounded-full"
        style={{ height: avatarSize, width: avatarSize }}
      />
      <div className="flex min-w-0 flex-col gap-1.5">
        <Skeleton className="h-3.5 w-32 max-w-[60%] rounded" />
        <Skeleton className="h-3 w-48 max-w-[80%] rounded" />
      </div>
      <div className="flex gap-2">
        <Skeleton className="size-9 rounded-lg" />
        {actions === 2 ? <Skeleton className="size-9 rounded-lg" /> : null}
      </div>
    </div>
  );
}

export function ProjectMembersListSkeleton(): React.ReactElement {
  return (
    <div aria-busy="true">
      <SkeletonRow
        actions={2}
        avatarSize={30}
      />
      <SkeletonRow
        actions={2}
        avatarSize={30}
      />
    </div>
  );
}

export function ProjectProvidersListSkeleton(): React.ReactElement {
  return (
    <div aria-busy="true">
      <SkeletonRow
        actions={1}
        avatarSize={34}
      />
      <SkeletonRow
        actions={1}
        avatarSize={34}
      />
      <SkeletonRow
        actions={1}
        avatarSize={34}
      />
    </div>
  );
}
