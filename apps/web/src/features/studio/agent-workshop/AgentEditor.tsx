import type { AgentId } from '@monad/protocol';

import { CheckIcon, LoaderPinwheelIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  useGetA2aStatusQuery,
  useGetAgentCredentialCapabilityQuery,
  useGetAgentPromptQuery,
  useGetAgentQuery,
  useListAgentCredentialsQuery,
  useSetAgentPromptMutation,
  useUpdateAgentMutation
} from '@monad/client-rtk';
import { Button, Skeleton } from '@monad/ui';
import { useEffect, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { agentDetailsPath } from '#/features/shell/routing/paths';
import { replaceShellUrl } from '#/hooks/use-shell-location';
import { StudioBreadcrumbHeader } from '../StudioBreadcrumbHeader';
import { AgentWorkshop } from './AgentWorkshop';
import { duplicateGrantedEnvironmentVariables } from './agent-credential-grants';
import { buildAgentEditorUpdate } from './agent-editor-update';
import { type AgentInstructionDraft, validateAgentFlow } from './agent-flow-model';

function credentialGrantError(error: unknown, t: ReturnType<typeof useT>): string {
  const candidate =
    error && typeof error === 'object' && 'data' in error && error.data && typeof error.data === 'object'
      ? error.data
      : error;
  if (!candidate || typeof candidate !== 'object' || !('code' in candidate)) {
    return t('web.credentials.grantSaveError');
  }
  const params =
    'params' in candidate && candidate.params && typeof candidate.params === 'object' ? candidate.params : {};
  if (candidate.code === 'agent_credential_not_found' && 'credentialId' in params) {
    return t('web.credentials.missingGrant', { id: String(params.credentialId) });
  }
  if (candidate.code === 'agent_credential_environment_variable_conflict' && 'environmentVariable' in params) {
    return t('web.credentials.duplicateEnvironmentVariables', { names: String(params.environmentVariable) });
  }
  return t('web.credentials.grantSaveError');
}

function AgentEditorSkeleton() {
  return (
    <section
      aria-busy="true"
      className="flex min-w-0 flex-1 flex-col"
    >
      <div className="flex items-center justify-between border-b px-5 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Skeleton className="h-4 w-20 rounded" />
          <Skeleton className="h-4 w-4 rounded-full" />
          <Skeleton className="h-4 w-36 rounded" />
        </div>
        <Skeleton className="h-8 w-20 rounded-md" />
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_18rem] gap-0 overflow-hidden">
        <div className="flex flex-col gap-4 overflow-hidden p-5">
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-24 w-full rounded-md" />
          <Skeleton className="h-56 w-full rounded-md" />
        </div>
        <div className="flex flex-col gap-3 border-l p-5">
          {Array.from({ length: 6 }, (_, i) => `agent-editor-side-${i}`).map((key) => (
            <div
              className="flex flex-col gap-2"
              key={key}
            >
              <Skeleton className="h-3 w-24 rounded" />
              <Skeleton className="h-8 w-full rounded-md" />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function AgentEditor({ agentId }: { agentId: AgentId; onClose: () => void }) {
  const t = useT();
  const { data: agentData, isLoading } = useGetAgentQuery(agentId);
  const { data: promptData } = useGetAgentPromptQuery(agentId);
  const { data: a2aStatusData } = useGetA2aStatusQuery(agentId);
  const credentialsQuery = useListAgentCredentialsQuery();
  const credentialCapabilityQuery = useGetAgentCredentialCapabilityQuery();
  const [updateAgent, { isLoading: saving }] = useUpdateAgentMutation();
  const [setAgentPrompt, { isLoading: savingPrompt }] = useSetAgentPromptMutation();

  const [name, setName] = useState('');
  const [model, setModel] = useState('');
  const [sandboxMode, setSandboxMode] = useState<'' | 'workspace' | 'home' | 'unrestricted' | 'ephemeral'>('');
  const [subagentCallable, setSubagentCallable] = useState(false);
  const [isPublic, setIsPublic] = useState(false);
  const [a2aEnabled, setA2aEnabled] = useState(false);
  const [monadixConsume, setMonadixConsume] = useState(false);
  const [instructions, setInstructions] = useState<AgentInstructionDraft>({ agent: '', user: '' });
  const [atomsMode, setAtomsMode] = useState<'inherit' | 'allowlist'>('inherit');
  const [atomsAllow, setAtomsAllow] = useState<string[]>([]);
  const [credentialIds, setCredentialIds] = useState<string[]>([]);
  const [skillsAutoload, setSkillsAutoload] = useState(true);
  const [skillsDisabled, setSkillsDisabled] = useState<string[]>([]);
  const [skillsMode, setSkillsMode] = useState<'inherit' | 'allowlist'>('inherit');
  const [skillsAllow, setSkillsAllow] = useState<string[]>([]);
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [maxTurns, setMaxTurns] = useState('');
  const [maxThinkingTokens, setMaxThinkingTokens] = useState('');
  const [maxBudgetUsd, setMaxBudgetUsd] = useState('');
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const [advancedMemoryEnabled, setAdvancedMemoryEnabled] = useState(true);
  const [memoryAutoConsolidate, setMemoryAutoConsolidate] = useState(false);
  const [memoryIntervalMinutes, setMemoryIntervalMinutes] = useState('30');
  const [credentialSaveError, setCredentialSaveError] = useState<string>();

  const agent = agentData?.agent;

  useEffect(() => {
    if (!agent) return;
    setName(agent.name);
    setModel(agent.model ?? '');
    setSandboxMode(agent.sandboxMode ?? '');
    setSubagentCallable(agent.visibility?.subagentCallable ?? false);
    setIsPublic(agent.visibility?.public ?? false);
    setA2aEnabled(agent.a2a?.enabled ?? false);
    setMonadixConsume(agent.monadix?.consume ?? false);
    setAtomsMode(agent.atoms?.mode ?? 'inherit');
    setAtomsAllow(agent.atoms?.allow ?? []);
    setCredentialIds(agent.credentialIds);
    setSkillsAutoload(agent.skills?.autoload ?? true);
    setSkillsDisabled(agent.skills?.disabled ?? []);
    setSkillsMode(agent.skills?.mode ?? 'inherit');
    setSkillsAllow(agent.skills?.allow ?? []);
    setRoles((agent.roles as Record<string, string>) ?? {});
    setMaxTurns(agent.maxTurns?.toString() ?? '');
    setMaxThinkingTokens(agent.maxThinkingTokens?.toString() ?? '');
    setMaxBudgetUsd(agent.maxBudgetUsd?.toString() ?? '');
    setMemoryEnabled(agent.memory.enabled);
    setAdvancedMemoryEnabled(agent.memory.advanced);
    setMemoryAutoConsolidate(agent.memory.autoConsolidate);
    setMemoryIntervalMinutes(String(agent.memory.intervalMinutes));
  }, [agent]);

  useEffect(() => {
    if (promptData) setInstructions(promptData.slots);
  }, [promptData]);

  const handleSave = async () => {
    if (!agent) return;
    setCredentialSaveError(undefined);
    try {
      await updateAgent(
        buildAgentEditorUpdate({
          agent,
          agentId,
          atomsAllow,
          atomsMode,
          credentialIds,
          isPublic,
          memoryEnabled,
          advancedMemoryEnabled,
          memoryAutoConsolidate,
          memoryIntervalMinutes,
          maxBudgetUsd,
          maxThinkingTokens,
          maxTurns,
          model,
          name,
          roles,
          sandboxMode,
          skillsAllow,
          skillsAutoload,
          skillsDisabled,
          skillsMode,
          subagentCallable,
          a2aEnabled,
          monadixConsume
        })
      ).unwrap();
    } catch (error) {
      setCredentialSaveError(credentialGrantError(error, t));
      return;
    }
    const promptChanged =
      promptData && (instructions.agent !== promptData.slots.agent || instructions.user !== promptData.slots.user);
    if (promptChanged) await setAgentPrompt({ agentId, slots: instructions }).unwrap();
    replaceShellUrl(agentDetailsPath(agentId));
  };

  if (isLoading || !agent) return <AgentEditorSkeleton />;

  const exposed = subagentCallable || isPublic || a2aEnabled;
  const { saveBlocked: flowSaveBlocked } = validateAgentFlow({
    a2aEnabled,
    atomsAllow,
    atomsMode,
    isPublic,
    maxBudgetUsd,
    maxThinkingTokens,
    maxTurns,
    model,
    name,
    instructions,
    roles,
    mcpCount: 0,
    memory: { available: true, factCount: 0 },
    sandboxMode,
    skillsAllow,
    skillsMode,
    subagentCallable
  });
  const duplicateEnvironmentVariables = duplicateGrantedEnvironmentVariables(
    credentialsQuery.data?.credentials ?? [],
    credentialIds
  );
  const saveBlocked = flowSaveBlocked || duplicateEnvironmentVariables.length > 0;

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <StudioBreadcrumbHeader
        actions={
          <>
            {exposed && (
              <span className="rounded-full border border-warning/40 bg-warning/10 px-2.5 py-1 text-[11px] text-warning">
                {t('web.studio.workshopExposed')}
              </span>
            )}
            <Button
              disabled={saving || savingPrompt || saveBlocked}
              onClick={() => void handleSave()}
              size="sm"
            >
              {saving || savingPrompt ? (
                <HugeiconsIcon
                  className="animate-spin"
                  icon={LoaderPinwheelIcon}
                />
              ) : (
                <HugeiconsIcon icon={CheckIcon} />
              )}
              {t('web.common.save')}
            </Button>
          </>
        }
        backHref={agentDetailsPath(agentId)}
        parentTitle={t('web.studio.agents')}
        title={name || agent.name}
      />

      <AgentWorkshop
        a2aEnabled={a2aEnabled}
        a2aStatus={a2aStatusData?.status}
        advancedMemoryEnabled={advancedMemoryEnabled}
        agentDir={agent.dir ?? ''}
        agentId={agentId}
        atomsAllow={atomsAllow}
        atomsMode={atomsMode}
        credentialCapability={credentialCapabilityQuery.data}
        credentialCapabilityLoading={credentialCapabilityQuery.isLoading}
        credentialError={credentialSaveError}
        credentialIds={credentialIds}
        credentials={credentialsQuery.data?.credentials ?? []}
        credentialsError={credentialsQuery.isError}
        credentialsLoading={credentialsQuery.isLoading}
        instructions={instructions}
        isPublic={isPublic}
        maxBudgetUsd={maxBudgetUsd}
        maxThinkingTokens={maxThinkingTokens}
        maxTurns={maxTurns}
        memoryAutoConsolidate={memoryAutoConsolidate}
        memoryEnabled={memoryEnabled}
        memoryIntervalMinutes={memoryIntervalMinutes}
        model={model}
        monadixConsume={monadixConsume}
        name={name}
        roles={roles}
        sandboxMode={sandboxMode}
        setA2aEnabled={setA2aEnabled}
        setAdvancedMemoryEnabled={setAdvancedMemoryEnabled}
        setAtomsAllow={setAtomsAllow}
        setAtomsMode={setAtomsMode}
        setCredentialIds={(value) => {
          setCredentialSaveError(undefined);
          setCredentialIds(value);
        }}
        setInstructions={setInstructions}
        setIsPublic={setIsPublic}
        setMaxBudgetUsd={setMaxBudgetUsd}
        setMaxThinkingTokens={setMaxThinkingTokens}
        setMaxTurns={setMaxTurns}
        setMemoryAutoConsolidate={setMemoryAutoConsolidate}
        setMemoryEnabled={setMemoryEnabled}
        setMemoryIntervalMinutes={setMemoryIntervalMinutes}
        setModel={setModel}
        setMonadixConsume={setMonadixConsume}
        setName={setName}
        setRoles={setRoles}
        setSandboxMode={setSandboxMode}
        setSkillsAllow={setSkillsAllow}
        setSkillsAutoload={setSkillsAutoload}
        setSkillsDisabled={setSkillsDisabled}
        setSkillsMode={setSkillsMode}
        setSubagentCallable={setSubagentCallable}
        skillsAllow={skillsAllow}
        skillsAutoload={skillsAutoload}
        skillsDisabled={skillsDisabled}
        skillsMode={skillsMode}
        subagentCallable={subagentCallable}
      />
    </section>
  );
}
