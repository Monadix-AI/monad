import { Skeleton } from '@monad/ui';

const SUMMARY_KEYS = ['providers', 'agents', 'projects', 'sessions', 'tokens'] as const;
const DETAIL_KEYS = ['mesh-detail-a', 'mesh-detail-b'] as const;

export function MeshUsageSkeleton() {
  return (
    <div
      aria-busy="true"
      className="flex flex-col gap-5"
    >
      <section className="rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2">
            <Skeleton className="h-5 w-44 rounded" />
            <Skeleton className="h-4 w-80 max-w-full rounded" />
          </div>
          <Skeleton className="h-4 w-32 rounded" />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {SUMMARY_KEYS.map((key) => (
            <div
              className="flex h-16 flex-col gap-2 rounded-lg border bg-card p-3"
              key={key}
            >
              <Skeleton className="h-3 w-20 max-w-full rounded" />
              <Skeleton className="h-4 w-12 rounded" />
            </div>
          ))}
        </div>
      </section>
      <section className="rounded-xl border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <div className="space-y-2">
            <Skeleton className="h-5 w-36 rounded" />
            <Skeleton className="h-4 w-72 max-w-full rounded" />
          </div>
          <Skeleton className="h-8 w-40 rounded-lg" />
        </div>
        <div className="grid gap-3 p-3 xl:grid-cols-2">
          {DETAIL_KEYS.map((key) => (
            <div
              className="flex h-56 min-w-0 flex-col gap-3 rounded-xl border bg-card p-4"
              key={key}
            >
              <div className="flex items-start gap-3">
                <Skeleton className="size-9 shrink-0 rounded-lg" />
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-4 w-32 rounded" />
                  <Skeleton className="h-3 w-48 max-w-full rounded" />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {['input', 'output', 'total'].map((metric) => (
                  <Skeleton
                    className="h-14 rounded-lg"
                    key={`${key}-${metric}`}
                  />
                ))}
              </div>
              <Skeleton className="mt-auto h-16 rounded-lg" />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
