import type { ComponentType, ReactNode } from 'react';

import { Skeleton } from '@monad/ui';

import { studioSectionFromPathname } from '#/features/shell/routing/paths';
import { useShellPathname } from '#/hooks/use-shell-location';
import { MeshUsageSkeleton } from './MeshUsageSkeleton';
import {
  AcpAgentsStudioLoading,
  ApprovalsStudioLoading,
  AtomsStudioLoading,
  CapabilitiesStudioLoading,
  ChannelsStudioLoading,
  CredentialsStudioLoading,
  HooksStudioLoading,
  ImportStudioLoading,
  MemoryGraphStudioLoading,
  MemoryMem0StudioLoading,
  MemorySettingsStudioLoading,
  MeshAgentsStudioLoading,
  ModelsStudioLoading,
  RuntimeStudioLoading,
  SkillsStudioLoading
} from './StudioLoading';
import { DEFAULT_STUDIO_SECTION, type StudioSectionId } from './sections';

const keys = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}-${index}`);

function RouteFrame({ children }: { children: ReactNode }) {
  return (
    <section
      aria-busy="true"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      {children}
    </section>
  );
}

function RouteHeader({ action = false }: { action?: boolean }) {
  return (
    <header className="panel-shell-header [.app-main-sidebar-collapsed_&]:!pl-[8.5rem] flex h-[52px] items-center gap-3 border-b bg-muted/20 px-4">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <Skeleton className="h-4 w-36 rounded" />
      </div>
      {action ? <Skeleton className="size-8 rounded-md" /> : null}
    </header>
  );
}

function RouteListCard() {
  return (
    <div className="flex min-h-20 items-start gap-3 rounded-lg border bg-card p-3">
      <Skeleton className="size-9 shrink-0 rounded-md" />
      <div className="min-w-0 flex-1 space-y-2">
        <Skeleton className="h-4 w-36 rounded" />
        <Skeleton className="h-3 w-full rounded" />
        <Skeleton className="h-3 w-3/4 rounded" />
      </div>
      <Skeleton className="h-8 w-20 shrink-0 rounded-md" />
    </div>
  );
}

function AgentsStudioRouteLoading() {
  return (
    <RouteFrame>
      <RouteHeader action />
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="flex w-full flex-col gap-3 p-5">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-3">
            {keys('agent-card', 6).map((key) => (
              <div
                className="flex min-h-24 items-center gap-3 rounded-xl border bg-card p-3"
                key={key}
              >
                <Skeleton className="size-10 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-4 w-32 rounded" />
                  <Skeleton className="h-4 w-40 max-w-full rounded-md" />
                </div>
                <Skeleton className="size-7 shrink-0 rounded-md" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </RouteFrame>
  );
}

function OrchestrationStudioRouteLoading() {
  return (
    <RouteFrame>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-5">
        <div className="flex items-start gap-3">
          <Skeleton className="size-4 shrink-0 rounded-md" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-5 w-44 rounded" />
            <Skeleton className="h-4 w-4/5 rounded" />
          </div>
        </div>
        <div className="flex gap-6">
          <div className="flex w-36 shrink-0 flex-col items-center gap-2 self-start rounded-lg border bg-card px-4 py-3">
            <Skeleton className="size-5 rounded-md" />
            <Skeleton className="h-4 w-20 rounded" />
            <Skeleton className="size-4 rounded-md" />
          </div>
          <div className="flex flex-1 flex-col gap-2 border-l pl-6">
            {keys('orchestration-target', 4).map((key) => (
              <RouteListCard key={key} />
            ))}
          </div>
        </div>
      </div>
    </RouteFrame>
  );
}

function MeshOverviewStudioRouteLoading() {
  return (
    <RouteFrame>
      <RouteHeader />
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="mx-auto grid w-full max-w-5xl gap-5 p-4 pb-24 lg:p-6 lg:pb-24">
          <main className="flex min-w-0 flex-col gap-5">
            <MeshUsageSkeleton />
          </main>
        </div>
      </div>
    </RouteFrame>
  );
}

function MeshPlaceholderStudioRouteLoading() {
  return (
    <RouteFrame>
      <RouteHeader />
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6 pb-24">
          <div className="rounded-xl border bg-card px-5 py-5">
            <div className="flex items-start gap-3">
              <Skeleton className="size-9 shrink-0 rounded-md" />
              <div className="min-w-0 flex-1 space-y-3">
                <Skeleton className="h-5 w-44 rounded" />
                <Skeleton className="h-4 w-4/5 rounded" />
                <div className="flex gap-2 pt-1">
                  <Skeleton className="h-8 w-28 rounded-md" />
                  <Skeleton className="h-8 w-32 rounded-md" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </RouteFrame>
  );
}

function SandboxStudioRouteLoading() {
  return (
    <RouteFrame>
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-5">
        <div className="space-y-2">
          <Skeleton className="h-5 w-44 rounded" />
          <Skeleton className="h-4 w-4/5 rounded" />
        </div>
        {keys('sandbox-section', 2).map((key) => (
          <section
            className="flex flex-col gap-2"
            key={key}
          >
            <Skeleton className="h-4 w-28 rounded" />
            <div className="divide-y rounded-lg border px-3">
              {keys(`${key}-row`, 4).map((rowKey) => (
                <div
                  className="flex items-center justify-between gap-4 py-2.5"
                  key={rowKey}
                >
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-32 rounded" />
                    <Skeleton className="h-3 w-52 max-w-full rounded" />
                  </div>
                  <Skeleton className="h-8 w-44 rounded-md" />
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </RouteFrame>
  );
}

function SafetyStudioRouteLoading() {
  return (
    <RouteFrame>
      <RouteHeader />
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="mx-auto grid w-full max-w-5xl gap-5 p-4 pb-24 lg:grid-cols-[minmax(0,1fr)_18rem] lg:p-6 lg:pb-24">
          <main className="rounded-xl border bg-card">
            <div className="space-y-3 border-b px-5 py-5">
              <Skeleton className="h-5 w-40 rounded" />
              <Skeleton className="h-4 w-4/5 rounded" />
            </div>
            <div className="space-y-1 p-2">
              <RouteListCard />
              <RouteListCard />
            </div>
          </main>
          <aside className="hidden h-48 rounded-xl border bg-card p-4 lg:block">
            <Skeleton className="size-9 rounded-md" />
            <Skeleton className="mt-3 h-4 w-32 rounded" />
            <Skeleton className="mt-3 h-3 w-full rounded" />
            <Skeleton className="mt-2 h-3 w-4/5 rounded" />
          </aside>
        </div>
      </div>
    </RouteFrame>
  );
}

const STUDIO_LOADING_COMPONENTS = {
  acpAgents: AcpAgentsStudioLoading,
  acpDelegates: AcpAgentsStudioLoading,
  agents: AgentsStudioRouteLoading,
  approvals: ApprovalsStudioLoading,
  atoms: AtomsStudioLoading,
  capabilities: CapabilitiesStudioLoading,
  channels: ChannelsStudioLoading,
  credentials: CredentialsStudioLoading,
  graph: MemoryGraphStudioLoading,
  hooks: HooksStudioLoading,
  import: ImportStudioLoading,
  mcpAtoms: CapabilitiesStudioLoading,
  mcpServers: CapabilitiesStudioLoading,
  mem0: MemoryMem0StudioLoading,
  memory: MemorySettingsStudioLoading,
  mesh: MeshOverviewStudioRouteLoading,
  meshAgents: MeshAgentsStudioLoading,
  meshTasks: MeshPlaceholderStudioRouteLoading,
  models: ModelsStudioLoading,
  orchestration: OrchestrationStudioRouteLoading,
  projectMembers: MeshPlaceholderStudioRouteLoading,
  runtime: RuntimeStudioLoading,
  safety: SafetyStudioRouteLoading,
  sandbox: SandboxStudioRouteLoading,
  skills: SkillsStudioLoading,
  thirdPartyAgents: AcpAgentsStudioLoading,
  tools: CapabilitiesStudioLoading
} satisfies Record<StudioSectionId, ComponentType>;

export function StudioRouteLoading() {
  const section = studioSectionFromPathname(useShellPathname()) ?? DEFAULT_STUDIO_SECTION;
  const Loading = STUDIO_LOADING_COMPONENTS[section];
  return <Loading />;
}
