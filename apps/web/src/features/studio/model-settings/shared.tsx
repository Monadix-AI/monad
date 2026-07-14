import type { CredentialView } from '@monad/protocol';

import { ModelProviderType } from '@monad/protocol';
import { cn, Skeleton } from '@monad/ui';

export interface AddForm {
  type: ModelProviderType;
  baseUrl: string;
  key: string;
}

export function emptyAddForm(): AddForm {
  return { type: ModelProviderType.Anthropic, baseUrl: '', key: '' };
}

export function toErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}

export function StatusDot({ status }: { status: CredentialView['lastStatus'] }) {
  const color = status === 'ok' ? 'bg-success' : status === 'error' ? 'bg-destructive' : 'bg-muted-foreground';
  return (
    <span
      className={cn('inline-block size-2 shrink-0 rounded-full', color)}
      title={status}
    />
  );
}

export function FormMsg({ msg }: { msg: string }) {
  const fail = msg.startsWith('✗');
  return <p className={cn('w-full text-xs', fail ? 'text-destructive' : 'text-muted-foreground')}>{msg}</p>;
}

function _usd(n: number): string {
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 4 })}`;
}

export function ModelSection({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <h3 className="shrink-0 font-medium text-muted-foreground text-xs">{title}</h3>
        <div className="h-px flex-1 bg-border/80" />
      </div>
      {children}
    </section>
  );
}

export function ModelEmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border/70 bg-muted/10 px-4 py-8 text-center text-muted-foreground text-sm">
      {children}
    </div>
  );
}

function SkeletonSection({
  cardClassName,
  count,
  gridClassName
}: {
  cardClassName: string;
  count: number;
  gridClassName: string;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Skeleton className="h-3 w-20 rounded" />
        <div className="h-px flex-1 bg-border/80" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Skeleton className="h-4 w-64 max-w-full rounded" />
        <Skeleton className="h-7 w-24 rounded" />
      </div>
      <div className={cn('grid gap-3', gridClassName)}>
        {Array.from({ length: count }, (_, i) => `skeleton-card-${i}`).map((key) => (
          <div
            className={cn('rounded-md border border-border/70 bg-muted/10', cardClassName)}
            key={key}
          />
        ))}
      </div>
    </section>
  );
}

/** Placeholder mirroring the providers + profiles layout while the first load is in flight, so the
 *  panel doesn't flash empty states before data arrives. */
export function ModelSettingsSkeleton() {
  return (
    <div
      aria-busy="true"
      className="mx-auto flex max-w-5xl flex-col gap-5 p-5"
    >
      <SkeletonSection
        cardClassName="h-[4.5rem]"
        count={3}
        gridClassName="grid-cols-[repeat(auto-fill,minmax(min(100%,24rem),1fr))] items-start"
      />
      <SkeletonSection
        cardClassName="h-72"
        count={2}
        gridClassName="grid-cols-[repeat(auto-fill,minmax(min(100%,28rem),1fr))] items-stretch"
      />
    </div>
  );
}
