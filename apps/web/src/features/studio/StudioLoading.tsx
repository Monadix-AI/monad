import type { ComponentType, ReactNode } from 'react';
import type { StudioSectionId } from './sections';

import { Card, Skeleton } from '@monad/ui';

import { studioSectionFromPathname } from '#/features/shell/routing/paths';
import { useShellPathname } from '#/hooks/use-shell-location';

const keys = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}-${index}`);

function StudioHeaderSkeleton({
  actions = 1,
  badge = false,
  subtitle = false
}: {
  actions?: number;
  badge?: boolean;
  subtitle?: boolean;
}) {
  return (
    <header className="panel-shell-header [.app-main-sidebar-collapsed_&]:!pl-[8.5rem] flex h-[52px] items-center gap-3 border-b bg-muted/20 px-4">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <Skeleton className="h-4 w-36 rounded" />
        {badge ? <Skeleton className="h-5 w-20 rounded-full" /> : null}
        {subtitle ? <Skeleton className="h-3 w-48 rounded" /> : null}
      </div>
      {keys('studio-header-action', actions).map((key) => (
        <Skeleton
          className="size-8 rounded-md"
          key={key}
        />
      ))}
    </header>
  );
}

function PanelFrame({ children }: { children: ReactNode }) {
  return (
    <section
      aria-busy="true"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      {children}
    </section>
  );
}

function RuntimeRowSkeleton({ index }: { index: number }) {
  return (
    <div className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-lg border bg-card px-4 py-3 sm:grid-cols-[2.25rem_minmax(0,1fr)_auto] sm:items-center">
      <Skeleton className="size-9 rounded-md" />
      <div className="min-w-0 space-y-2">
        <div className="flex items-center gap-2">
          <Skeleton className="h-4 w-36 rounded" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
        <Skeleton className={index % 2 === 0 ? 'h-4 w-4/5 rounded' : 'h-4 w-2/3 rounded'} />
      </div>
      <Skeleton className="col-start-2 h-8 w-24 justify-self-start rounded-md sm:col-start-auto" />
    </div>
  );
}

function RuntimeStudioLoading() {
  return (
    <PanelFrame>
      <StudioHeaderSkeleton
        actions={0}
        badge
      />
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="mx-auto grid h-full max-w-6xl gap-5 overflow-hidden p-4 lg:grid-cols-[minmax(0,1fr)_19rem] lg:p-6">
          <main className="flex min-w-0 flex-col gap-5 overflow-hidden">
            <Card className="grid gap-5 px-5 py-5 md:grid-cols-[minmax(0,1fr)_17rem] md:items-center">
              <div className="min-w-0 space-y-3">
                <Skeleton className="h-4 w-11/12 rounded" />
                <Skeleton className="h-4 w-4/5 rounded" />
                <div className="flex gap-2 pt-2">
                  <Skeleton className="h-8 w-28 rounded-md" />
                  <Skeleton className="h-8 w-24 rounded-md" />
                </div>
              </div>
              <Skeleton className="hidden aspect-[4/3] rounded-lg md:block" />
            </Card>
            <section className="flex flex-col gap-3">
              <div className="flex items-end justify-between gap-3">
                <div className="space-y-2">
                  <Skeleton className="h-5 w-44 rounded" />
                  <Skeleton className="h-4 w-72 rounded" />
                </div>
                <Skeleton className="hidden h-6 w-28 rounded-full sm:block" />
              </div>
              {keys('runtime-row', 4).map((key, index) => (
                <RuntimeRowSkeleton
                  index={index}
                  key={key}
                />
              ))}
            </section>
          </main>
          <aside className="hidden min-w-0 flex-col gap-3 overflow-hidden lg:flex">
            <Card className="gap-3 p-4">
              <Skeleton className="h-4 w-28 rounded" />
              <Skeleton className="h-3 w-full rounded" />
              <Skeleton className="h-3 w-4/5 rounded" />
              <div className="space-y-2 pt-2">
                {keys('runtime-link', 3).map((key) => (
                  <Skeleton
                    className="h-8 w-full rounded-md"
                    key={key}
                  />
                ))}
              </div>
            </Card>
            <Card className="gap-3 p-4">
              <Skeleton className="h-4 w-24 rounded" />
              <Skeleton className="h-20 w-full rounded-md" />
            </Card>
          </aside>
        </div>
      </div>
    </PanelFrame>
  );
}

export function ModelsStudioLoading() {
  return (
    <PanelFrame>
      <StudioHeaderSkeleton actions={0} />
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="mx-auto flex max-w-5xl flex-col gap-5 p-5">
          <ModelSectionLoading
            cardClassName="h-[4.5rem]"
            count={3}
            gridClassName="grid-cols-[repeat(auto-fill,minmax(min(100%,24rem),1fr))]"
          />
          <ModelSectionLoading
            cardClassName="h-72"
            count={2}
            gridClassName="grid-cols-[repeat(auto-fill,minmax(min(100%,28rem),1fr))]"
          />
        </div>
      </div>
    </PanelFrame>
  );
}

function ModelSectionLoading({
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
      <div className={`grid gap-3 ${gridClassName}`}>
        {keys('model-card', count).map((key) => (
          <div
            className={`rounded-md border border-border/70 bg-muted/10 ${cardClassName}`}
            key={key}
          />
        ))}
      </div>
    </section>
  );
}

function ListCardSkeleton({ accessory = 'button' }: { accessory?: 'badge' | 'button' | 'toggle' }) {
  return (
    <div className="flex min-h-20 items-start gap-3 rounded-lg border bg-card p-3">
      <Skeleton className="size-9 rounded-md" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-center gap-2">
          <Skeleton className="h-4 w-36 rounded" />
          {accessory === 'badge' ? <Skeleton className="h-5 w-16 rounded-full" /> : null}
        </div>
        <Skeleton className="h-3 w-full rounded" />
        <Skeleton className="h-3 w-3/4 rounded" />
      </div>
      {accessory === 'toggle' ? (
        <Skeleton className="h-5 w-9 rounded-full" />
      ) : accessory === 'button' ? (
        <Skeleton className="h-8 w-20 rounded-md" />
      ) : null}
    </div>
  );
}

export function ChannelsStudioLoading() {
  return (
    <PanelFrame>
      <StudioHeaderSkeleton
        actions={2}
        subtitle
      />
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden p-4">
        {keys('channel', 5).map((key) => (
          <ListCardSkeleton
            accessory="toggle"
            key={key}
          />
        ))}
      </div>
    </PanelFrame>
  );
}

export function AtomsStudioLoading() {
  return (
    <PanelFrame>
      <StudioHeaderSkeleton
        actions={3}
        subtitle
      />
      <div className="min-h-0 flex-1 space-y-2 overflow-hidden p-4">
        {keys('atom-pack', 5).map((key) => (
          <ListCardSkeleton
            accessory="toggle"
            key={key}
          />
        ))}
      </div>
      <footer className="flex flex-wrap gap-1.5 border-t px-5 py-2">
        {keys('atom-kind', 5).map((key) => (
          <Skeleton
            className="h-5 w-16 rounded-full"
            key={key}
          />
        ))}
      </footer>
    </PanelFrame>
  );
}

export function SkillsStudioLoading() {
  return (
    <PanelFrame>
      <StudioHeaderSkeleton
        actions={3}
        subtitle
      />
      <div className="grid min-h-0 flex-1 gap-4 overflow-hidden p-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <main className="flex min-w-0 flex-col gap-4">
          <section className="grid gap-3 sm:grid-cols-2">
            <SettingsControlSkeleton />
            <SettingsControlSkeleton />
          </section>
          <section className="flex flex-col gap-2">
            <Skeleton className="h-4 w-28 rounded" />
            <div className="grid gap-2 md:grid-cols-2">
              {keys('skill-global', 4).map((key) => (
                <ListCardSkeleton
                  accessory="toggle"
                  key={key}
                />
              ))}
            </div>
          </section>
        </main>
        <aside className="hidden min-w-0 flex-col gap-2 xl:flex">
          <SettingsControlSkeleton />
          <SettingsControlSkeleton />
        </aside>
      </div>
    </PanelFrame>
  );
}

function SettingsControlSkeleton() {
  return (
    <Card className="gap-2 p-4">
      <div className="flex items-center justify-between gap-3">
        <Skeleton className="h-4 w-32 rounded" />
        <Skeleton className="h-5 w-9 rounded-full" />
      </div>
      <Skeleton className="h-3 w-full rounded" />
      <Skeleton className="h-3 w-3/4 rounded" />
    </Card>
  );
}

export function CapabilitiesStudioLoading() {
  return (
    <PanelFrame>
      <StudioHeaderSkeleton actions={0} />
      <div className="min-h-0 flex-1 space-y-6 overflow-hidden p-5">
        <section className="space-y-3">
          <Skeleton className="h-5 w-40 rounded" />
          <div className="grid gap-2 md:grid-cols-2">
            <SettingsControlSkeleton />
            <SettingsControlSkeleton />
          </div>
        </section>
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <Skeleton className="h-5 w-36 rounded" />
            <Skeleton className="size-8 rounded-md" />
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-3">
            {keys('tool-card', 6).map((key) => (
              <ListCardSkeleton
                accessory="badge"
                key={key}
              />
            ))}
          </div>
        </section>
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <Skeleton className="h-5 w-32 rounded" />
            <div className="flex gap-1">
              <Skeleton className="size-8 rounded-md" />
              <Skeleton className="size-8 rounded-md" />
            </div>
          </div>
          {keys('mcp-server', 3).map((key) => (
            <ListCardSkeleton
              accessory="toggle"
              key={key}
            />
          ))}
        </section>
      </div>
    </PanelFrame>
  );
}

export function ImportStudioLoading() {
  return (
    <PanelFrame>
      <StudioHeaderSkeleton actions={0} />
      <div className="mx-auto grid w-full max-w-6xl gap-5 overflow-hidden p-5">
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <Skeleton className="h-5 w-40 rounded" />
            <Skeleton className="h-8 w-20 rounded-md" />
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-3">
            {keys('inventory-card', 6).map((key) => (
              <ListCardSkeleton
                accessory="badge"
                key={key}
              />
            ))}
          </div>
        </section>
      </div>
    </PanelFrame>
  );
}

export function ApprovalsStudioLoading() {
  return (
    <PanelFrame>
      <StudioHeaderSkeleton actions={0} />
      <div className="flex flex-1 flex-col gap-4 px-6 py-6">
        <div className="flex items-center justify-between gap-4">
          <Skeleton className="h-4 w-3/5 rounded" />
          <Skeleton className="h-8 w-24 rounded-md" />
        </div>
        <div className="flex flex-col gap-1">
          {keys('approval-rule', 6).map((key) => (
            <div
              className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
              key={key}
            >
              <div className="flex min-w-0 items-center gap-2">
                <Skeleton className="h-4 w-10 rounded" />
                <Skeleton className="h-4 w-64 rounded" />
                <Skeleton className="h-3 w-20 rounded" />
              </div>
              <Skeleton className="h-8 w-16 rounded-md" />
            </div>
          ))}
        </div>
      </div>
    </PanelFrame>
  );
}

export function MemorySettingsStudioLoading() {
  return (
    <MemoryStudioFrame>
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-hidden px-6 py-6">
        <section className="space-y-3">
          <Skeleton className="h-4 w-32 rounded" />
          <Skeleton className="h-4 w-2/3 rounded" />
          <Skeleton className="h-8 w-48 rounded-md" />
          <Card className="gap-3 p-4">
            <Skeleton className="h-4 w-44 rounded" />
            <Skeleton className="h-3 w-full rounded" />
            <div className="grid gap-4 sm:grid-cols-2">
              <Skeleton className="h-9 w-full rounded-md" />
              <Skeleton className="h-9 w-full rounded-md" />
            </div>
          </Card>
        </section>
        <div className="h-px bg-border" />
        <section className="space-y-3">
          <Skeleton className="h-4 w-40 rounded" />
          <Skeleton className="h-20 w-full rounded-md" />
        </section>
      </div>
    </MemoryStudioFrame>
  );
}

function MemoryStudioFrame({ children }: { children: ReactNode }) {
  return (
    <PanelFrame>
      <StudioHeaderSkeleton
        actions={1}
        badge
      />
      {children}
    </PanelFrame>
  );
}

export function MemoryGraphStudioLoading() {
  return (
    <MemoryStudioFrame>
      <div className="flex items-center gap-3 border-b px-6 py-2">
        <Skeleton className="h-3 w-20 rounded" />
        <Skeleton className="ml-auto h-8 w-20 rounded-md" />
      </div>
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 flex flex-col gap-3 p-6">
          <div className="flex flex-wrap gap-2">
            <Skeleton className="h-5 w-20 rounded-full" />
            <Skeleton className="h-5 w-24 rounded-full" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
          <div className="relative min-h-0 flex-1 rounded-lg border bg-muted/10">
            <Skeleton className="absolute top-[18%] left-[18%] h-10 w-28 rounded-lg" />
            <Skeleton className="absolute top-[32%] right-[20%] h-10 w-32 rounded-lg" />
            <Skeleton className="absolute bottom-[24%] left-[34%] h-10 w-28 rounded-lg" />
            <Skeleton className="absolute right-[30%] bottom-[16%] h-10 w-24 rounded-lg" />
            <span className="absolute top-[25%] left-[35%] h-px w-[28%] rotate-12 bg-border" />
            <span className="absolute right-[35%] bottom-[31%] h-px w-[24%] -rotate-12 bg-border" />
          </div>
        </div>
      </div>
    </MemoryStudioFrame>
  );
}

export function MemoryMem0StudioLoading() {
  return (
    <MemoryStudioFrame>
      <div className="flex items-center gap-3 border-b px-6 py-2">
        <Skeleton className="h-3 w-16 rounded" />
        <Skeleton className="ml-auto h-8 w-20 rounded-md" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-hidden px-6 py-5">
        <section className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <Skeleton className="h-4 w-28 rounded" />
          <Skeleton className="h-4 w-36 rounded" />
          <Skeleton className="h-4 w-52 rounded" />
        </section>
        <section className="flex flex-col gap-2">
          <Skeleton className="h-3 w-24 rounded" />
          <div className="relative h-48 rounded-lg border bg-muted/10 p-2">
            {keys('mem0-dot', 18).map((key, index) => (
              <Skeleton
                className="absolute size-2 rounded-full"
                key={key}
                style={{
                  left: `${12 + ((index * 31) % 76)}%`,
                  top: `${16 + ((index * 17) % 66)}%`
                }}
              />
            ))}
          </div>
        </section>
        <section className="flex flex-col gap-2">
          <Skeleton className="h-3 w-20 rounded" />
          {keys('mem0-entry', 4).map((key) => (
            <div
              className="flex items-start gap-2 rounded-md border px-3 py-2"
              key={key}
            >
              <Skeleton className="mt-1.5 size-2 shrink-0 rounded-full" />
              <Skeleton className="h-4 w-4/5 rounded" />
            </div>
          ))}
        </section>
      </div>
    </MemoryStudioFrame>
  );
}

export function HooksStudioLoading() {
  return (
    <PanelFrame>
      <StudioHeaderSkeleton
        actions={1}
        subtitle
      />
      <div className="grid min-h-0 flex-1 grid-cols-[14rem_minmax(0,1fr)] gap-0 overflow-hidden">
        <div className="flex flex-col gap-2 border-r p-5">
          {keys('hook-event', 8).map((key) => (
            <div
              className="flex items-center justify-between rounded-md border px-3 py-2"
              key={key}
            >
              <Skeleton className="h-4 w-24 rounded" />
              <Skeleton className="h-5 w-6 rounded-full" />
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-3 p-5">
          <Skeleton className="h-5 w-44 rounded" />
          <Skeleton className="h-4 w-4/5 rounded" />
          {keys('hook-card', 4).map((key) => (
            <div
              className="rounded-lg border p-3"
              key={key}
            >
              <Skeleton className="h-4 w-32 rounded" />
              <Skeleton className="mt-2 h-3 w-3/4 rounded" />
            </div>
          ))}
        </div>
      </div>
      <div className="border-t px-5 py-3">
        <Skeleton className="h-8 w-20 rounded-md" />
      </div>
    </PanelFrame>
  );
}

export function AcpAgentsStudioLoading() {
  return (
    <PanelFrame>
      <StudioHeaderSkeleton actions={0} />
      <div className="border-b bg-muted/20 px-5 py-3">
        <Skeleton className="h-4 w-3/5 rounded" />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden p-5">
        <section className="mx-auto max-w-5xl overflow-hidden rounded-xl border bg-card">
          <div className="border-b bg-muted/30 px-5 py-2">
            <Skeleton className="h-3 w-4/5 rounded" />
          </div>
          <div className="flex flex-col gap-2 p-4">
            <PresetPanelSkeleton />
            {keys('acp-agent', 3).map((key) => (
              <ListCardSkeleton
                accessory="toggle"
                key={key}
              />
            ))}
          </div>
        </section>
      </div>
    </PanelFrame>
  );
}

export function MeshAgentsStudioLoading() {
  return (
    <PanelFrame>
      <StudioHeaderSkeleton
        actions={2}
        subtitle
      />
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden p-4">
        <PresetPanelSkeleton />
        {keys('mesh-agent', 3).map((key) => (
          <ListCardSkeleton
            accessory="toggle"
            key={key}
          />
        ))}
      </div>
    </PanelFrame>
  );
}

function PresetPanelSkeleton() {
  return (
    <div className="grid gap-3 rounded-lg border bg-muted/40 p-3 md:grid-cols-[minmax(10rem,0.72fr)_minmax(0,1.9fr)]">
      <div className="space-y-2 px-1">
        <Skeleton className="h-4 w-28 rounded" />
        <Skeleton className="h-3 w-full rounded" />
        <Skeleton className="h-3 w-3/4 rounded" />
      </div>
      <div className="flex flex-col gap-2">
        {keys('preset-row', 3).map((key) => (
          <div
            className="grid min-h-14 grid-cols-[34px_minmax(0,1fr)_auto] items-center gap-2 rounded-md border bg-card px-2 py-2"
            key={key}
          >
            <Skeleton className="size-8 rounded-md" />
            <div className="space-y-1.5">
              <Skeleton className="h-4 w-32 rounded" />
              <Skeleton className="h-3 w-52 rounded" />
            </div>
            <Skeleton className="h-8 w-20 rounded-md" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function StudioRouteLoading() {
  const section = studioSectionFromPathname(useShellPathname()) ?? 'runtime';
  const Loading = STUDIO_LOADING_COMPONENTS[section] ?? RuntimeStudioLoading;
  return <Loading />;
}

const STUDIO_LOADING_COMPONENTS: Partial<Record<StudioSectionId, ComponentType>> = {
  acpAgents: AcpAgentsStudioLoading,
  acpDelegates: AcpAgentsStudioLoading,
  approvals: ApprovalsStudioLoading,
  atoms: AtomsStudioLoading,
  capabilities: CapabilitiesStudioLoading,
  channels: ChannelsStudioLoading,
  meshAgents: MeshAgentsStudioLoading,
  graph: MemoryGraphStudioLoading,
  hooks: HooksStudioLoading,
  import: ImportStudioLoading,
  mcpAtoms: CapabilitiesStudioLoading,
  mcpServers: CapabilitiesStudioLoading,
  mem0: MemoryMem0StudioLoading,
  memory: MemorySettingsStudioLoading,
  models: ModelsStudioLoading,
  skills: SkillsStudioLoading,
  thirdPartyAgents: AcpAgentsStudioLoading,
  tools: CapabilitiesStudioLoading,
  runtime: RuntimeStudioLoading
};

function _StudioLoading() {
  return <RuntimeStudioLoading />;
}
