import type { Agent, AgentId, AgentMemorySettings } from '@monad/protocol';

import { agentSelectors, useGetAppearanceQuery, useListAgentsQuery, useUpdateAgentMutation } from '@monad/client-rtk';
import { Badge, Input, Skeleton } from '@monad/ui';
import { AgentAvatar } from '@monad/ui/components/AgentAvatar';
import { useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { SwitchSetting } from '#/components/ui/switch-setting';
import { agentCardAvatar } from '../agent-card-avatar';

export function effectiveAgentMemoryLevel(agent: Agent): 0 | 1 | 3 {
  if (!agent.memory.enabled) return 0;
  if (!agent.memory.advanced) return 1;
  return 3;
}

export function memoryAfterEnabledToggle(memory: AgentMemorySettings, enabled: boolean): AgentMemorySettings {
  return { ...memory, enabled };
}

export function memoryAfterAdvancedToggle(memory: AgentMemorySettings, advanced: boolean): AgentMemorySettings {
  return { ...memory, advanced };
}

export function memoryAfterAutoConsolidateToggle(
  memory: AgentMemorySettings,
  autoConsolidate: boolean
): AgentMemorySettings {
  return { ...memory, autoConsolidate };
}

export function memoryAfterIntervalChange(memory: AgentMemorySettings, intervalMinutes: number): AgentMemorySettings {
  return { ...memory, intervalMinutes };
}

export function AgentMemorySettingsSection() {
  const t = useT();
  const agentsQuery = useListAgentsQuery();
  const { data: appearance } = useGetAppearanceQuery();
  const [updateAgent] = useUpdateAgentMutation();
  const [pending, setPending] = useState<AgentId | null>(null);
  const [errors, setErrors] = useState<Partial<Record<AgentId, string>>>({});
  const [intervalDrafts, setIntervalDrafts] = useState<Partial<Record<AgentId, string>>>({});
  const agents = agentsQuery.data ? agentSelectors.selectAll(agentsQuery.data) : [];

  const update = async (agent: Agent, memory: Agent['memory']) => {
    setPending(agent.id);
    setErrors((current) => ({ ...current, [agent.id]: undefined }));
    try {
      await updateAgent({ agentId: agent.id, memory }).unwrap();
    } catch {
      setErrors((current) => ({ ...current, [agent.id]: t('web.memory.byAgentUpdateError') }));
    } finally {
      setPending(null);
    }
  };

  const commitInterval = (agent: Agent) => {
    const draft = intervalDrafts[agent.id];
    if (draft === undefined) return;
    const intervalMinutes = Number(draft);
    setIntervalDrafts((current) => {
      const next = { ...current };
      delete next[agent.id];
      return next;
    });
    if (Number.isInteger(intervalMinutes) && intervalMinutes > 0 && intervalMinutes !== agent.memory.intervalMinutes) {
      void update(agent, memoryAfterIntervalChange(agent.memory, intervalMinutes));
    }
  };

  return (
    <section>
      <h2 className="font-medium text-sm">{t('web.memory.byAgentTitle')}</h2>
      <p className="mt-1 text-muted-foreground text-sm">{t('web.memory.byAgentHint')}</p>

      {agentsQuery.isLoading ? (
        <div className="mt-3 flex flex-col gap-2">
          <Skeleton className="h-20 rounded-xl" />
          <Skeleton className="h-20 rounded-xl" />
        </div>
      ) : agentsQuery.isError ? (
        <p className="mt-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-destructive text-sm">
          {t('web.memory.byAgentLoadError')}
        </p>
      ) : agents.length === 0 ? (
        <p className="mt-3 rounded-xl border border-dashed p-4 text-muted-foreground text-sm">
          {t('web.memory.byAgentEmpty')}
        </p>
      ) : (
        <div className="mt-3 divide-y rounded-xl border">
          {agents.map((agent) => {
            const busy = pending === agent.id;
            const currentLevel = effectiveAgentMemoryLevel(agent);
            return (
              <div
                className="flex flex-wrap items-center gap-4 p-4"
                key={agent.id}
              >
                <AgentAvatar
                  agent={agentCardAvatar(agent, appearance?.avatarStyle)}
                  size={36}
                />
                <div className="min-w-36 flex-1">
                  <p className="truncate font-medium text-sm">{agent.name}</p>
                  <Badge
                    className="mt-1"
                    variant={currentLevel === 0 ? 'outline' : 'secondary'}
                  >
                    {currentLevel === 0
                      ? t('web.memory.effectiveOff')
                      : t('web.memory.effectiveLevel', { level: currentLevel })}
                  </Badge>
                  {errors[agent.id] ? <p className="mt-1 text-destructive text-xs">{errors[agent.id]}</p> : null}
                </div>
                <div className="grid w-full gap-2 sm:grid-cols-2 xl:grid-cols-4">
                  <SwitchSetting
                    checked={agent.memory.enabled}
                    className="rounded-md border px-3 py-2"
                    disabled={busy}
                    onCheckedChange={(enabled) => void update(agent, memoryAfterEnabledToggle(agent.memory, enabled))}
                    title={t('web.memory.memorySwitch')}
                  />
                  <SwitchSetting
                    checked={agent.memory.advanced}
                    className="rounded-md border px-3 py-2"
                    disabled={busy || !agent.memory.enabled}
                    onCheckedChange={(advanced) =>
                      void update(agent, memoryAfterAdvancedToggle(agent.memory, advanced))
                    }
                    title={t('web.memory.advancedSwitch')}
                  />
                  <SwitchSetting
                    checked={agent.memory.autoConsolidate}
                    className="rounded-md border px-3 py-2"
                    disabled={busy || !agent.memory.enabled}
                    onCheckedChange={(autoConsolidate) =>
                      void update(agent, memoryAfterAutoConsolidateToggle(agent.memory, autoConsolidate))
                    }
                    title={t('web.memory.autoConsolidateSwitch')}
                  />
                  <div className="flex min-w-0 items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
                    <span className="min-w-0">{t('web.memory.intervalMinutes')}</span>
                    <Input
                      aria-label={t('web.memory.intervalMinutes')}
                      className="h-8 w-20 shrink-0"
                      disabled={busy || !agent.memory.enabled || !agent.memory.autoConsolidate}
                      min={1}
                      onBlur={() => commitInterval(agent)}
                      onChange={(event) =>
                        setIntervalDrafts((current) => ({ ...current, [agent.id]: event.target.value }))
                      }
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') commitInterval(agent);
                      }}
                      type="number"
                      value={intervalDrafts[agent.id] ?? String(agent.memory.intervalMinutes)}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
