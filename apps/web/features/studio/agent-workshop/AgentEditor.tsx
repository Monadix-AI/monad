'use client';

import type { AgentId } from '@monad/protocol';

import { CheckIcon, LoaderPinwheelIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  useGetA2aStatusQuery,
  useGetAgentPromptQuery,
  useGetAgentQuery,
  useSetAgentPromptMutation,
  useUpdateAgentMutation
} from '@monad/client-rtk';
import { Button, Skeleton } from '@monad/ui';
import { useEffect, useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { studioPath } from '@/features/routes/route-paths';
import { StudioBreadcrumbHeader } from '../StudioBreadcrumbHeader';
import { AgentWorkshop } from './AgentWorkshop';
import { buildAgentEditorUpdate } from './agent-editor-update';

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
  const [updateAgent, { isLoading: saving }] = useUpdateAgentMutation();
  const [setAgentPrompt, { isLoading: savingPrompt }] = useSetAgentPromptMutation();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [model, setModel] = useState('');
  const [sandboxMode, setSandboxMode] = useState<'' | 'workspace' | 'home' | 'unrestricted' | 'ephemeral'>('');
  const [subagentCallable, setSubagentCallable] = useState(false);
  const [isPublic, setIsPublic] = useState(false);
  const [a2aEnabled, setA2aEnabled] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [atomsMode, setAtomsMode] = useState<'inherit' | 'allowlist'>('inherit');
  const [atomsAllow, setAtomsAllow] = useState<string[]>([]);
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [maxTurns, setMaxTurns] = useState('');
  const [maxThinkingTokens, setMaxThinkingTokens] = useState('');
  const [maxBudgetUsd, setMaxBudgetUsd] = useState('');

  const agent = agentData?.agent;

  useEffect(() => {
    if (!agent) return;
    setName(agent.name);
    setDescription(agent.description ?? '');
    setModel(agent.model ?? '');
    setSandboxMode(agent.sandboxMode ?? '');
    setSubagentCallable(agent.visibility?.subagentCallable ?? false);
    setIsPublic(agent.visibility?.public ?? false);
    setA2aEnabled(agent.a2a?.enabled ?? false);
    setAtomsMode(agent.atoms?.mode ?? 'inherit');
    setAtomsAllow(agent.atoms?.allow ?? []);
    setRoles((agent.roles as Record<string, string>) ?? {});
    setMaxTurns(agent.maxTurns?.toString() ?? '');
    setMaxThinkingTokens(agent.maxThinkingTokens?.toString() ?? '');
    setMaxBudgetUsd(agent.maxBudgetUsd?.toString() ?? '');
  }, [agent]);

  useEffect(() => {
    if (promptData) setPrompt(promptData.prompt);
  }, [promptData]);

  const handleSave = async () => {
    if (!agent) return;
    await updateAgent(
      buildAgentEditorUpdate({
        agent,
        agentId,
        atomsAllow,
        atomsMode,
        description,
        isPublic,
        maxBudgetUsd,
        maxThinkingTokens,
        maxTurns,
        model,
        name,
        roles,
        sandboxMode,
        subagentCallable,
        a2aEnabled
      })
    ).unwrap();
    if (promptData && prompt !== promptData.prompt) {
      await setAgentPrompt({ agentId, prompt }).unwrap();
    }
  };

  if (isLoading || !agent) return <AgentEditorSkeleton />;

  const exposed = subagentCallable || isPublic || a2aEnabled;

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
              disabled={saving || savingPrompt}
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
        backHref={studioPath('agents')}
        parentTitle={t('web.studio.agents')}
        title={name || agent.name}
      />

      <AgentWorkshop
        a2aEnabled={a2aEnabled}
        a2aStatus={a2aStatusData?.status}
        atomsAllow={atomsAllow}
        atomsMode={atomsMode}
        description={description}
        isPublic={isPublic}
        maxBudgetUsd={maxBudgetUsd}
        maxThinkingTokens={maxThinkingTokens}
        maxTurns={maxTurns}
        model={model}
        name={name}
        prompt={prompt}
        roles={roles}
        sandboxMode={sandboxMode}
        setA2aEnabled={setA2aEnabled}
        setAtomsAllow={setAtomsAllow}
        setAtomsMode={setAtomsMode}
        setDescription={setDescription}
        setIsPublic={setIsPublic}
        setMaxBudgetUsd={setMaxBudgetUsd}
        setMaxThinkingTokens={setMaxThinkingTokens}
        setMaxTurns={setMaxTurns}
        setModel={setModel}
        setName={setName}
        setPrompt={setPrompt}
        setRoles={setRoles}
        setSandboxMode={setSandboxMode}
        setSubagentCallable={setSubagentCallable}
        subagentCallable={subagentCallable}
      />
    </section>
  );
}
