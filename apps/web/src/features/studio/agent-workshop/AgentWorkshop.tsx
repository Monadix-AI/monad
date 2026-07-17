import type { A2aAgentStatus, SandboxMode } from '@monad/protocol';

import { MessageMultiple01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  atomPackAdapter,
  atomPackSelectors,
  mcpServerAdapter,
  mcpServerSelectors,
  useListAtomPacksQuery,
  useListMcpServersQuery
} from '@monad/client-rtk';
import { Button, cn } from '@monad/ui';
import { ReactFlowProvider } from '@xyflow/react';
import { useEffect, useMemo, useState } from 'react';

import { useModelSettings } from '#/hooks/use-model-settings';
import { AgentFlowCanvas } from './AgentFlowCanvas';
import { type AgentFlowCapability, AgentFlowPanel } from './AgentFlowPanel';
import {
  type AgentFlowInput,
  type AgentFlowNodeId,
  agentFlowSummaries,
  deriveAgentFlowReadiness,
  validateAgentFlow
} from './agent-flow-model';

interface AgentWorkshopProps {
  a2aEnabled: boolean;
  monadixConsume: boolean;
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
  setMonadixConsume: (value: boolean) => void;
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

export function AgentWorkshop(props: AgentWorkshopProps) {
  const { profiles } = useModelSettings();
  const [selected, setSelected] = useState<AgentFlowNodeId | null>('identity');
  const { data: atomData } = useListAtomPacksQuery();
  const mcpQuery = useListMcpServersQuery();

  const capabilityCatalog = useMemo<AgentFlowCapability[]>(
    () => [
      ...atomPackSelectors
        .selectAll(atomData?.atomPacks ?? atomPackAdapter.getInitialState())
        .filter((pack) => pack.enabled)
        .map((pack) => ({ name: pack.name, detail: pack.atoms.join(', '), sourceKind: 'atom' as const })),
      ...mcpServerSelectors
        .selectAll(mcpQuery.data ?? mcpServerAdapter.getInitialState())
        .map((server) => ({ name: server.name, detail: 'MCP server', sourceKind: 'mcp' as const }))
    ],
    [atomData?.atomPacks, mcpQuery.data]
  );

  const flowInput: AgentFlowInput = {
    a2aEnabled: props.a2aEnabled,
    atomsAllow: props.atomsAllow,
    atomsMode: props.atomsMode,
    isPublic: props.isPublic,
    maxBudgetUsd: props.maxBudgetUsd,
    maxThinkingTokens: props.maxThinkingTokens,
    maxTurns: props.maxTurns,
    model: props.model,
    name: props.name,
    prompt: props.prompt,
    sandboxMode: props.sandboxMode,
    subagentCallable: props.subagentCallable
  };
  const summaries = agentFlowSummaries(flowInput);
  const readiness = deriveAgentFlowReadiness(flowInput);
  const validation = validateAgentFlow(flowInput);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div
      className="relative flex min-h-0 flex-1 overflow-hidden bg-background"
      data-testid="agent-workshop"
    >
      <div className={cn('min-h-0 min-w-0 flex-1 transition-[margin]', selected && 'lg:mr-[500px]')}>
        <ReactFlowProvider>
          <AgentFlowCanvas
            onClearSelection={() => setSelected(null)}
            onSelect={setSelected}
            selected={selected}
            summaries={summaries}
          />
        </ReactFlowProvider>
      </div>

      <div
        className={cn(
          'pointer-events-none absolute inset-x-5 top-4 z-10 flex items-center justify-between gap-3 max-md:inset-x-3',
          selected && 'lg:right-[520px]'
        )}
      >
        <div className="pointer-events-auto flex items-center gap-2 rounded-full border bg-background/95 px-3 py-2 text-xs shadow-sm backdrop-blur">
          <span
            className={readiness.saveBlocked ? 'size-2 rounded-full bg-destructive' : 'size-2 rounded-full bg-success'}
          />
          <span className="font-medium">{readiness.label}</span>
          {readiness.optionalImprovements > 0 ? (
            <span className="text-muted-foreground">· {readiness.optionalImprovements} optional improvements</span>
          ) : null}
        </div>
        <Button
          className="pointer-events-auto bg-background/95 shadow-sm backdrop-blur"
          onClick={() => setSelected('request')}
          size="sm"
          variant="outline"
        >
          <HugeiconsIcon icon={MessageMultiple01Icon} />
          Try with a sample request
        </Button>
      </div>

      {selected ? (
        <AgentFlowPanel
          {...props}
          capabilityCatalog={capabilityCatalog}
          capabilityCatalogLoading={atomData === undefined || mcpQuery.isLoading}
          errors={validation.errors}
          onClose={() => setSelected(null)}
          profiles={profiles}
          selected={selected}
        />
      ) : null}
    </div>
  );
}
