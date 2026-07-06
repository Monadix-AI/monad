'use client';

import type { WebMessageIdWithoutParams } from '@monad/i18n';
import type { A2aAgentStatus, SandboxMode } from '@monad/protocol';
import type { DragEvent } from 'react';

import {
  atomPackAdapter,
  atomPackSelectors,
  mcpServerAdapter,
  mcpServerSelectors,
  useListAtomPacksQuery,
  useListMcpServersQuery
} from '@monad/client-rtk';
import { ScrollArea } from '@monad/ui';
import { useMemo, useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { useModelSettings } from '@/hooks/use-model-settings';
import { AgentWorkshopHeader } from './AgentWorkshopHeader';
import { AgentWorkshopInspector } from './AgentWorkshopInspector';
import { AgentWorkshopPartsBin } from './AgentWorkshopPartsBin';
import { type CapabilityItem, parsePayload, type WorkshopPart } from './AgentWorkshopPrimitives';
import { AgentWorkshopWorkbench } from './AgentWorkshopWorkbench';

interface AgentWorkshopProps {
  a2aEnabled: boolean;
  a2aStatus?: A2aAgentStatus;
  atomsAllow: string[];
  atomsMode: 'inherit' | 'allowlist';
  description: string;
  isPublic: boolean;
  maxBudgetUsd: string;
  maxThinkingTokens: string;
  maxTurns: string;
  model: string;
  name: string;
  prompt: string;
  roles: Record<string, string>;
  sandboxMode: SandboxMode | '';
  setA2aEnabled: (value: boolean) => void;
  setAtomsAllow: (value: string[] | ((prev: string[]) => string[])) => void;
  setAtomsMode: (mode: 'inherit' | 'allowlist') => void;
  setDescription: (value: string) => void;
  setIsPublic: (value: boolean) => void;
  setMaxBudgetUsd: (value: string) => void;
  setMaxThinkingTokens: (value: string) => void;
  setMaxTurns: (value: string) => void;
  setModel: (value: string) => void;
  setName: (value: string) => void;
  setPrompt: (value: string) => void;
  setRoles: (value: Record<string, string> | ((prev: Record<string, string>) => Record<string, string>)) => void;
  setSandboxMode: (value: SandboxMode | '') => void;
  setSubagentCallable: (value: boolean) => void;
  subagentCallable: boolean;
}

export function AgentWorkshop({
  a2aEnabled,
  a2aStatus,
  atomsAllow,
  atomsMode,
  description,
  isPublic,
  maxBudgetUsd,
  maxThinkingTokens,
  maxTurns,
  model,
  name,
  prompt,
  roles,
  sandboxMode,
  setA2aEnabled,
  setAtomsAllow,
  setAtomsMode,
  setDescription,
  setIsPublic,
  setMaxBudgetUsd,
  setMaxThinkingTokens,
  setMaxTurns,
  setModel,
  setName,
  setPrompt,
  setRoles,
  setSandboxMode,
  setSubagentCallable,
  subagentCallable
}: AgentWorkshopProps) {
  const t = useT();
  const { profiles } = useModelSettings();
  const [selectedPart, setSelectedPart] = useState<WorkshopPart>('brain');
  const [promptMode, setPromptMode] = useState<'write' | 'preview'>('write');
  const [draggingPart, setDraggingPart] = useState<WorkshopPart | null>(null);
  const { data: atomData } = useListAtomPacksQuery();
  const mcpQuery = useListMcpServersQuery();

  const packs = useMemo(
    () =>
      atomPackSelectors
        .selectAll(atomData?.atomPacks ?? atomPackAdapter.getInitialState())
        .filter((pack) => pack.enabled),
    [atomData?.atomPacks]
  );
  const servers = useMemo(
    () => mcpServerSelectors.selectAll(mcpQuery.data ?? mcpServerAdapter.getInitialState()),
    [mcpQuery.data]
  );
  const capabilityCatalog = useMemo<CapabilityItem[]>(
    () => [
      ...packs.map((pack) => ({ name: pack.name, detail: pack.atoms.join(', '), sourceKind: 'atom' as const })),
      ...servers.map((server) => ({ name: server.name, detail: 'MCP server', sourceKind: 'mcp' as const }))
    ],
    [packs, servers]
  );

  const roleCount = Object.keys(roles).length;
  const allowCount = atomsMode === 'allowlist' ? atomsAllow.length : packs.length + servers.length;
  const exposed = subagentCallable || isPublic || a2aEnabled;
  const safetyConfigured = Boolean(sandboxMode || maxTurns || maxThinkingTokens || maxBudgetUsd);
  const toolsConfigured = atomsMode === 'allowlist' || atomsAllow.length > 0;
  const partsInstalled = [
    Boolean(model || roleCount),
    Boolean(prompt.trim()),
    toolsConfigured,
    safetyConfigured,
    exposed
  ].filter(Boolean).length;
  const partCompletion: { active: boolean; label: string; part: WorkshopPart }[] = [
    { active: Boolean(model || roleCount), label: t('web.studio.workshopBrain'), part: 'brain' },
    { active: Boolean(prompt.trim()), label: t('web.studio.workshopPrompt'), part: 'prompt' },
    { active: toolsConfigured, label: t('web.studio.workshopTools'), part: 'tools' },
    { active: safetyConfigured, label: t('web.studio.workshopSafety'), part: 'safety' },
    { active: exposed, label: t('web.studio.workshopVisibility'), part: 'visibility' }
  ];
  const nextAssemblyPart = partCompletion.find(({ active }) => !active)?.part ?? null;
  const readinessKey: WebMessageIdWithoutParams = exposed
    ? 'web.studio.workshopStateDeployable'
    : safetyConfigured
      ? 'web.studio.workshopStateSafe'
      : model || roleCount || prompt.trim() || toolsConfigured
        ? 'web.studio.workshopStateRunnable'
        : 'web.studio.workshopStateBlank';

  const mountCapability = (name: string) => {
    setSelectedPart('tools');
    setAtomsMode('allowlist');
    setAtomsAllow((prev) => (prev.includes(name) ? prev : [...prev, name]));
  };

  const handleDrop = (slot: WorkshopPart, event: DragEvent<HTMLButtonElement | HTMLDivElement>) => {
    event.preventDefault();
    const payload = parsePayload(event);
    setDraggingPart(null);
    if (!payload) return;
    if (payload.type === 'part') {
      if (payload.part === slot) setSelectedPart(slot);
      return;
    }
    if (slot !== 'tools') return;
    mountCapability(payload.name);
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background"
      data-testid="agent-workshop"
    >
      <AgentWorkshopHeader
        a2aEnabled={a2aEnabled}
        allowCount={allowCount}
        atomsMode={atomsMode}
        description={description}
        exposed={exposed}
        isPublic={isPublic}
        model={model}
        name={name}
        nextAssemblyPart={nextAssemblyPart}
        partCompletion={partCompletion}
        partsInstalled={partsInstalled}
        readinessKey={readinessKey}
        sandboxMode={sandboxMode}
        setDescription={setDescription}
        setModel={setModel}
        setName={setName}
        setSelectedPart={setSelectedPart}
        subagentCallable={subagentCallable}
      />

      <div className="grid min-h-0 flex-1 lg:grid-cols-[240px_minmax(0,1fr)] min-[1500px]:grid-cols-[280px_minmax(0,1fr)_360px]">
        <AgentWorkshopPartsBin
          capabilityCatalog={capabilityCatalog}
          mountCapability={mountCapability}
          selectedPart={selectedPart}
          setDraggingPart={setDraggingPart}
          setSelectedPart={setSelectedPart}
        />

        <AgentWorkshopWorkbench
          a2aEnabled={a2aEnabled}
          atomsAllow={atomsAllow}
          atomsMode={atomsMode}
          draggingPart={draggingPart}
          exposed={exposed}
          isPublic={isPublic}
          maxBudgetUsd={maxBudgetUsd}
          maxThinkingTokens={maxThinkingTokens}
          maxTurns={maxTurns}
          model={model}
          onDrop={handleDrop}
          prompt={prompt}
          roleCount={roleCount}
          safetyConfigured={safetyConfigured}
          sandboxMode={sandboxMode}
          selectedPart={selectedPart}
          setSelectedPart={setSelectedPart}
          subagentCallable={subagentCallable}
          toolsConfigured={toolsConfigured}
        />

        <ScrollArea className="border-t lg:col-span-2 min-[1500px]:col-span-1 min-[1500px]:border-t-0 min-[1500px]:border-l">
          <AgentWorkshopInspector
            a2aEnabled={a2aEnabled}
            a2aStatus={a2aStatus}
            atomsAllow={atomsAllow}
            atomsMode={atomsMode}
            capabilityCatalog={capabilityCatalog}
            exposed={exposed}
            isPublic={isPublic}
            maxBudgetUsd={maxBudgetUsd}
            maxThinkingTokens={maxThinkingTokens}
            maxTurns={maxTurns}
            model={model}
            profiles={profiles}
            prompt={prompt}
            promptMode={promptMode}
            roles={roles}
            sandboxMode={sandboxMode}
            selectedPart={selectedPart}
            setA2aEnabled={setA2aEnabled}
            setAtomsAllow={setAtomsAllow}
            setAtomsMode={setAtomsMode}
            setIsPublic={setIsPublic}
            setMaxBudgetUsd={setMaxBudgetUsd}
            setMaxThinkingTokens={setMaxThinkingTokens}
            setMaxTurns={setMaxTurns}
            setModel={setModel}
            setPrompt={setPrompt}
            setPromptMode={setPromptMode}
            setRoles={setRoles}
            setSandboxMode={setSandboxMode}
            setSubagentCallable={setSubagentCallable}
            subagentCallable={subagentCallable}
          />
        </ScrollArea>
      </div>
    </div>
  );
}
