import { cn } from '@monad/ui';

const INSTALLED_SKILL_SKELETON_KEYS = [
  'installed-skill-1',
  'installed-skill-2',
  'installed-skill-3',
  'installed-skill-4',
  'installed-skill-5',
  'installed-skill-6'
];
const BROWSE_SKILL_SKELETON_KEYS = [
  'browse-skill-1',
  'browse-skill-2',
  'browse-skill-3',
  'browse-skill-4',
  'browse-skill-5',
  'browse-skill-6'
];
export const BROWSE_MORE_SKELETON_KEYS = ['browse-more-1', 'browse-more-2'];
export { BROWSE_SKILL_SKELETON_KEYS };
export function SkeletonBlock({ className }: { className?: string }) {
  return <span className={cn('block animate-pulse rounded-sm bg-muted', className)} />;
}

function SkillCardSkeleton() {
  return (
    <div className="flex min-h-32 flex-col rounded-md border border-border/70 bg-card">
      <div className="flex flex-1 items-start gap-3 p-3">
        <SkeletonBlock className="size-9 rounded-md" />
        <div className="min-w-0 flex-1 space-y-2">
          <SkeletonBlock className="h-4 w-2/3" />
          <SkeletonBlock className="h-3 w-full" />
          <SkeletonBlock className="h-3 w-4/5" />
        </div>
      </div>
      <div className="flex items-center justify-between border-t px-3 py-2">
        <SkeletonBlock className="h-5 w-20 rounded-full" />
        <div className="flex gap-2">
          <SkeletonBlock className="h-5 w-12 rounded-full" />
          <SkeletonBlock className="h-5 w-12 rounded-full" />
        </div>
      </div>
    </div>
  );
}

export function InstalledSkillsSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <SkeletonBlock className="h-4 w-24" />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] items-stretch gap-3">
        {INSTALLED_SKILL_SKELETON_KEYS.map((key) => (
          <SkillCardSkeleton key={key} />
        ))}
      </div>
    </div>
  );
}

export function BrowseSkillCardSkeleton({ className }: { className: string }) {
  return (
    <div className={className}>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <SkeletonBlock className="h-4 w-2/3" />
        <SkeletonBlock className="h-3 w-full" />
        <SkeletonBlock className="h-3 w-4/5" />
      </div>
      <div className="flex items-center gap-1.5 pt-1">
        <SkeletonBlock className="h-5 w-12 rounded-full" />
        <SkeletonBlock className="h-5 w-14 rounded-full" />
        <SkeletonBlock className="ml-auto h-6 w-16 rounded-md" />
      </div>
    </div>
  );
}

export function SkillDetailSkeleton() {
  return (
    <div className="flex flex-col gap-4 p-4">
      <SkeletonBlock className="h-4 w-3/4" />
      <SkeletonBlock className="h-4 w-1/2" />
      <div className="space-y-2 pt-2">
        <SkeletonBlock className="h-3 w-full" />
        <SkeletonBlock className="h-3 w-11/12" />
        <SkeletonBlock className="h-3 w-4/5" />
      </div>
      <div className="space-y-2 pt-3">
        <SkeletonBlock className="h-3 w-full" />
        <SkeletonBlock className="h-3 w-full" />
        <SkeletonBlock className="h-3 w-2/3" />
      </div>
    </div>
  );
}
