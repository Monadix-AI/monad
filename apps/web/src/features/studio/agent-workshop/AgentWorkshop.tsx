import type {
  A2aAgentStatus,
  AgentCredentialCapability,
  AgentCredentialView,
  AgentId,
  SandboxMode
} from '@monad/protocol';
import type { AgentFlowCapability, AgentFlowSkill } from './panels/types';

import { Cancel01Icon, MessageMultiple01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  atomPackAdapter,
  atomPackSelectors,
  factSelectors,
  mcpServerAdapter,
  mcpServerSelectors,
  useGetImportInventoryQuery,
  useGetMemoryStatusQuery,
  useListAtomPacksQuery,
  useListMcpServersQuery,
  useListMemoryFactsQuery,
  useListSkillsQuery
} from '@monad/client-rtk';
import { Button, cn, Textarea } from '@monad/ui';
import { ReactFlowProvider } from '@xyflow/react';
import { useEffect, useMemo, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { useModelSettings } from '#/hooks/use-model-settings';
import { AgentFlowCanvas } from './AgentFlowCanvas';
import { AgentFlowPanel } from './AgentFlowPanel';
import {
  type AgentFlowInput,
  type AgentFlowNodeId,
  type AgentInstructionDraft,
  agentFlowSummaries,
  deriveAgentFlowReadiness,
  validateAgentFlow
} from './agent-flow-model';

interface AgentWorkshopProps {
  a2aEnabled: boolean;
  a2aStatus?: A2aAgentStatus;
  agentId: AgentId;
  agentDir: string;
  atomsAllow: string[];
  atomsMode: 'inherit' | 'allowlist';
  credentialCapability?: AgentCredentialCapability;
  credentialCapabilityLoading: boolean;
  credentialError?: string;
  credentialIds: string[];
  credentials: AgentCredentialView[];
  credentialsError: boolean;
  credentialsLoading: boolean;
  instructions: AgentInstructionDraft;
  isPublic: boolean;
  maxBudgetUsd: string;
  maxThinkingTokens: string;
  maxTurns: string;
  memoryEnabled: boolean;
  advancedMemoryEnabled: boolean;
  memoryAutoConsolidate: boolean;
  memoryIntervalMinutes: string;
  model: string;
  monadixConsume: boolean;
  name: string;
  roles: Record<string, string>;
  sandboxMode: SandboxMode | '';
  setA2aEnabled: (value: boolean) => void;
  setAtomsAllow: (value: string[] | ((prev: string[]) => string[])) => void;
  setAtomsMode: (mode: 'inherit' | 'allowlist') => void;
  setCredentialIds: (value: string[] | ((prev: string[]) => string[])) => void;
  setInstructions: (value: AgentInstructionDraft) => void;
  setIsPublic: (value: boolean) => void;
  setMaxBudgetUsd: (value: string) => void;
  setMaxThinkingTokens: (value: string) => void;
  setMaxTurns: (value: string) => void;
  setMemoryEnabled: (value: boolean) => void;
  setAdvancedMemoryEnabled: (value: boolean) => void;
  setMemoryAutoConsolidate: (value: boolean) => void;
  setMemoryIntervalMinutes: (value: string) => void;
  setModel: (value: string) => void;
  setMonadixConsume: (value: boolean) => void;
  setName: (value: string) => void;
  setRoles: (value: Record<string, string> | ((prev: Record<string, string>) => Record<string, string>)) => void;
  setSandboxMode: (value: SandboxMode | '') => void;
  setSkillsAllow: (value: string[] | ((prev: string[]) => string[])) => void;
  setSkillsAutoload: (value: boolean) => void;
  setSkillsDisabled: (value: string[] | ((prev: string[]) => string[])) => void;
  setSkillsMode: (mode: 'inherit' | 'allowlist') => void;
  setSubagentCallable: (value: boolean) => void;
  subagentCallable: boolean;
  skillsAutoload: boolean;
  skillsAllow: string[];
  skillsDisabled: string[];
  skillsMode: 'inherit' | 'allowlist';
}

export function AgentWorkshop(props: AgentWorkshopProps) {
  const t = useT();
  const { profiles } = useModelSettings();
  const [selected, setSelected] = useState<AgentFlowNodeId | null>('identity');
  const [sampleOpen, setSampleOpen] = useState(false);
  const [sample, setSample] = useState(() => t('web.studio.agentEditor.sampleDefault'));
  const { data: atomData } = useListAtomPacksQuery();
  const mcpQuery = useListMcpServersQuery();
  const skillsQuery = useListSkillsQuery({ scope: ['global', 'atom-pack', 'agent'] });
  const inventoryQuery = useGetImportInventoryQuery();
  const { data: memoryStatus } = useGetMemoryStatusQuery();
  const { data: memoryFacts } = useListMemoryFactsQuery({ scopeKind: 'agent', scopeId: props.agentId });
  const facts = factSelectors.selectAll(memoryFacts?.facts ?? { ids: [], entities: {} });
  const mcpServers = mcpServerSelectors.selectAll(mcpQuery.data ?? mcpServerAdapter.getInitialState());
  const builtInCapabilities = useMemo<AgentFlowCapability[]>(
    () => [
      {
        id: 'tool:web-search',
        name: t('web.tools.searchTool'),
        detail: t('web.tools.webSearchDesc'),
        sourceKind: 'tool',
        available: true
      },
      {
        id: 'tool:code-execution',
        name: t('web.tools.codeExec'),
        detail: t('web.tools.codeExecDesc'),
        sourceKind: 'tool',
        available: true
      },
      {
        id: 'tool:email-messaging',
        name: t('web.tools.email'),
        detail: t('web.tools.emailDesc'),
        sourceKind: 'tool',
        available: true
      },
      {
        id: 'tool:file-system',
        name: t('web.tools.filesystem'),
        detail: t('web.tools.filesystemDesc'),
        sourceKind: 'tool',
        available: true
      },
      {
        id: 'tool:shell-terminal',
        name: t('web.tools.shell'),
        detail: t('web.tools.shellDesc'),
        sourceKind: 'tool',
        available: true
      },
      {
        id: 'tool:process-runtime',
        name: t('web.tools.process'),
        detail: t('web.tools.processDesc'),
        sourceKind: 'tool',
        available: true
      },
      {
        id: 'tool:network-access',
        name: t('web.tools.network'),
        detail: t('web.tools.networkDesc'),
        sourceKind: 'tool',
        available: true
      },
      {
        id: 'tool:web-extraction',
        name: t('web.tools.webExtract'),
        detail: t('web.tools.webExtractDesc'),
        sourceKind: 'tool',
        available: true
      },
      {
        id: 'tool:task-list',
        name: t('web.tools.todo'),
        detail: t('web.tools.todoDesc'),
        sourceKind: 'tool',
        available: true
      },
      {
        id: 'tool:memory',
        name: t('web.tools.memory'),
        detail: t('web.tools.memoryDesc'),
        sourceKind: 'tool',
        available: true
      },
      {
        id: 'tool:schedule-automation',
        name: t('web.tools.schedule'),
        detail: t('web.tools.scheduleDesc'),
        sourceKind: 'tool',
        available: true
      }
    ],
    [t]
  );

  const capabilityCatalog = useMemo<AgentFlowCapability[]>(
    () => [
      ...builtInCapabilities,
      ...atomPackSelectors
        .selectAll(atomData?.atomPacks ?? atomPackAdapter.getInitialState())
        .filter((pack) => pack.enabled)
        .map((pack) => ({
          id: pack.name,
          name: pack.name,
          detail: pack.atoms.join(', '),
          sourceKind: 'atom' as const,
          available: true
        })),
      ...mcpServers.map((server) => ({
        id: server.name,
        name: server.name,
        detail: t('web.studio.agentEditor.tools.workspaceMcp'),
        sourceKind: 'mcp' as const,
        available: server.enabled
      })),
      ...(inventoryQuery.data?.items ?? []).flatMap((item) =>
        item.kind === 'mcpServer' && item.ownerAgentDir === props.agentDir
          ? [
              {
                id: `agent:${props.agentDir}:mcp:${item.name}`,
                name: item.name,
                detail: item.transport === 'http' ? (item.url ?? item.path) : (item.command ?? item.path),
                sourceKind: 'agent-mcp' as const,
                available: item.warnings.length === 0
              }
            ]
          : []
      )
    ],
    [atomData?.atomPacks, builtInCapabilities, inventoryQuery.data?.items, mcpServers, props.agentDir, t]
  );
  const skills = useMemo<AgentFlowSkill[]>(
    () =>
      (skillsQuery.data?.skillInstances ?? [])
        .filter((skill) => skill.sourceKind !== 'agent' || skill.sourceId === `agent:${props.agentDir}`)
        .map((skill) => ({
          id: skill.id,
          name: skill.name,
          detail: skill.description,
          sourceKind: skill.sourceKind,
          available: skill.available
        })),
    [props.agentDir, skillsQuery.data?.skillInstances]
  );
  const flowInput: AgentFlowInput = {
    a2aEnabled: props.a2aEnabled,
    atomsAllow: props.atomsAllow,
    atomsMode: props.atomsMode,
    instructions: props.instructions,
    isPublic: props.isPublic,
    maxBudgetUsd: props.maxBudgetUsd,
    maxThinkingTokens: props.maxThinkingTokens,
    maxTurns: props.maxTurns,
    mcpCount: mcpServers.length,
    memory: { available: Boolean(memoryStatus), factCount: facts.length },
    model: props.model,
    name: props.name,
    roles: props.roles,
    sandboxMode: props.sandboxMode,
    skillsAllow: props.skillsAllow,
    skillsMode: props.skillsMode,
    subagentCallable: props.subagentCallable
  };
  const summaries = agentFlowSummaries(flowInput, t);
  const readiness = deriveAgentFlowReadiness(flowInput);
  const validation = validateAgentFlow(flowInput);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSelected(null);
        setSampleOpen(false);
      }
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
          <span className="font-medium">
            {t(readiness.saveBlocked ? 'web.studio.agentEditor.needsAttention' : 'web.studio.agentEditor.ready')}
          </span>
          {readiness.optionalImprovements > 0 ? (
            <span className="text-muted-foreground">
              · {t('web.studio.agentEditor.optionalImprovements', { count: readiness.optionalImprovements })}
            </span>
          ) : null}
        </div>
        <Button
          className="pointer-events-auto bg-background/95 shadow-sm backdrop-blur"
          onClick={() => setSampleOpen((value) => !value)}
          size="sm"
          variant="outline"
        >
          <HugeiconsIcon icon={MessageMultiple01Icon} />
          {t('web.studio.agentEditor.sampleAction')}
        </Button>
      </div>

      {sampleOpen ? (
        <section className="absolute top-16 left-5 z-20 w-[min(24rem,calc(100%-2.5rem))] rounded-2xl border bg-background p-4 shadow-xl">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="font-medium text-sm">{t('web.studio.agentEditor.sampleTitle')}</h2>
              <p className="mt-0.5 text-muted-foreground text-xs">{t('web.studio.agentEditor.sampleHint')}</p>
            </div>
            <Button
              aria-label={t('web.studio.agentEditor.sampleClose')}
              onClick={() => setSampleOpen(false)}
              size="icon"
              variant="ghost"
            >
              <HugeiconsIcon icon={Cancel01Icon} />
            </Button>
          </div>
          <Textarea
            aria-label={t('web.studio.agentEditor.sampleTitle')}
            className="mt-3 min-h-24"
            onChange={(event) => setSample(event.target.value)}
            value={sample}
          />
        </section>
      ) : null}

      {selected ? (
        <AgentFlowPanel
          channels={{
            a2aEnabled: props.a2aEnabled,
            a2aStatus: props.a2aStatus,
            isPublic: props.isPublic,
            monadixConsume: props.monadixConsume,
            setA2aEnabled: props.setA2aEnabled,
            setIsPublic: props.setIsPublic,
            setMonadixConsume: props.setMonadixConsume,
            setSubagentCallable: props.setSubagentCallable,
            subagentCallable: props.subagentCallable
          }}
          identity={{
            errors: validation.errors,
            instructions: props.instructions,
            name: props.name,
            setInstructions: props.setInstructions,
            setName: props.setName
          }}
          memory={{
            agentId: props.agentId,
            advancedMemoryEnabled: props.advancedMemoryEnabled,
            memoryAutoConsolidate: props.memoryAutoConsolidate,
            memoryEnabled: props.memoryEnabled,
            memoryIntervalMinutes: props.memoryIntervalMinutes,
            setAdvancedMemoryEnabled: props.setAdvancedMemoryEnabled,
            setMemoryAutoConsolidate: props.setMemoryAutoConsolidate,
            setMemoryEnabled: props.setMemoryEnabled,
            setMemoryIntervalMinutes: props.setMemoryIntervalMinutes
          }}
          models={{
            errors: validation.errors,
            maxBudgetUsd: props.maxBudgetUsd,
            maxThinkingTokens: props.maxThinkingTokens,
            maxTurns: props.maxTurns,
            model: props.model,
            profiles,
            roles: props.roles,
            setMaxBudgetUsd: props.setMaxBudgetUsd,
            setMaxThinkingTokens: props.setMaxThinkingTokens,
            setMaxTurns: props.setMaxTurns,
            setModel: props.setModel,
            setRoles: props.setRoles
          }}
          onClose={() => setSelected(null)}
          sandbox={{
            credentialCapability: props.credentialCapability,
            credentialCapabilityLoading: props.credentialCapabilityLoading,
            credentialError: props.credentialError,
            credentialIds: props.credentialIds,
            credentials: props.credentials,
            credentialsError: props.credentialsError,
            credentialsLoading: props.credentialsLoading,
            sandboxMode: props.sandboxMode,
            setCredentialIds: props.setCredentialIds,
            setSandboxMode: props.setSandboxMode
          }}
          selected={selected}
          skills={{
            agentDir: props.agentDir,
            agentId: props.agentId,
            onRefresh: () => {
              void skillsQuery.refetch();
            },
            setSkillsAllow: props.setSkillsAllow,
            setSkillsMode: props.setSkillsMode,
            skills,
            skillsAllow: props.skillsAllow,
            skillsLoading: skillsQuery.isLoading,
            skillsMode: props.skillsMode
          }}
          tools={{
            agentDir: props.agentDir,
            agentId: props.agentId,
            atomsAllow: props.atomsAllow,
            atomsMode: props.atomsMode,
            capabilityCatalog,
            capabilityCatalogLoading: atomData === undefined || mcpQuery.isLoading || inventoryQuery.isLoading,
            onRefresh: () => {
              void inventoryQuery.refetch();
            },
            setAtomsAllow: props.setAtomsAllow,
            setAtomsMode: props.setAtomsMode
          }}
        />
      ) : null}
    </div>
  );
}
