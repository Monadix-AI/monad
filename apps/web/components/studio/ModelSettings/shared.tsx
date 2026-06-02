'use client';

import type { CredentialView, ModelPrice } from '@monad/protocol';

import { ModelProviderType } from '@monad/protocol';
import { cn } from '@monad/ui';
import { ArrowDownToLine, ArrowUpFromLine, Database } from 'lucide-react';

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

function usd(n: number): string {
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 4 })}`;
}

export function ModelPriceTag({ className, price }: { className?: string; price: ModelPrice }) {
  const present = (v: number | undefined): v is number => v !== undefined;
  const cache = [price.cacheRead, price.cacheWrite].filter(present).map(usd).join('/');
  const items = [
    price.input !== undefined
      ? { icon: ArrowDownToLine, label: 'Input', value: usd(price.input), title: `Input ${usd(price.input)} /1M` }
      : null,
    price.output !== undefined
      ? { icon: ArrowUpFromLine, label: 'Output', value: usd(price.output), title: `Output ${usd(price.output)} /1M` }
      : null,
    cache ? { icon: Database, label: 'Cached', value: cache, title: `Cached ${cache} /1M` } : null
  ].filter((item): item is { icon: typeof ArrowDownToLine; label: string; title: string; value: string } =>
    Boolean(item)
  );

  if (items.length === 0) return null;
  return (
    <span
      className={cn('flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground tabular-nums', className)}
    >
      {items.map(({ icon: Icon, label, title, value }) => (
        <span
          className="inline-flex min-w-0 items-center gap-1"
          key={label}
          title={title}
        >
          <Icon className="size-3 text-muted-foreground/70" />
          <span className="truncate">
            {value}
            <span className="text-muted-foreground/60"> /1M</span>
          </span>
        </span>
      ))}
    </span>
  );
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
        <div className="h-3 w-20 animate-pulse rounded bg-muted motion-reduce:animate-none" />
        <div className="h-px flex-1 bg-border/80" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="h-4 w-64 max-w-full animate-pulse rounded bg-muted motion-reduce:animate-none" />
        <div className="h-7 w-24 animate-pulse rounded bg-muted motion-reduce:animate-none" />
      </div>
      <div className={cn('grid gap-3', gridClassName)}>
        {Array.from({ length: count }, (_, i) => `skeleton-card-${i}`).map((key) => (
          <div
            className={cn(
              'animate-pulse rounded-md border border-border/70 bg-muted/10 motion-reduce:animate-none',
              cardClassName
            )}
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
        cardClassName="h-56"
        count={2}
        gridClassName="grid-cols-[repeat(auto-fill,minmax(min(100%,22rem),1fr))] items-stretch"
      />
    </div>
  );
}
