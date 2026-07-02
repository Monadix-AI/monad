'use client';

import type { Agent } from '@monad/protocol';

import {
  ArrowRight01Icon,
  BotIcon,
  LoaderPinwheelIcon,
  NeuralNetworkIcon,
  UserGroupIcon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useListAgentsQuery } from '@monad/client-rtk';
import { Badge, ScrollArea } from '@monad/ui';

import { useT } from '@/components/I18nProvider';

/** Studio › Agents › Orchestration: a read-only delegation map. Delegation is global — any agent may
 *  call any `subagentCallable` agent via agent_delegate_to — so the map is a hub (Any agent) → the
 *  roster of delegatable targets, each annotated with its tool exposure + model. Derived purely from
 *  agents.list (no dedicated RPC); the deterministic multi-agent DAG is deferred. */
export function Orchestration() {
  const t = useT();
  const { data, isLoading } = useListAgentsQuery();
  const targets = (data?.agents ?? []).filter((a) => a.visibility?.subagentCallable);

  const toolLabel = (a: Agent): string =>
    a.atoms?.mode === 'allowlist'
      ? `${a.atoms.allow.length} ${t('web.studio.orchestrationAllowed')}`
      : t('web.studio.orchestrationAllTools');

  return (
    <ScrollArea className="flex-1">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 p-5">
        <header className="flex items-start gap-3">
          <HugeiconsIcon
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            icon={NeuralNetworkIcon}
          />
          <div className="flex flex-col gap-1">
            <h2 className="font-medium text-base">{t('web.studio.orchestrationTitle')}</h2>
            <p className="text-muted-foreground text-sm">{t('web.studio.orchestrationDesc')}</p>
          </div>
        </header>

        {isLoading && (
          <HugeiconsIcon
            className="size-4 animate-spin text-muted-foreground"
            icon={LoaderPinwheelIcon}
          />
        )}

        {!isLoading && targets.length === 0 && (
          <div className="mx-auto flex max-w-xs flex-col items-center gap-3 py-16 text-center">
            <HugeiconsIcon
              className="size-8 text-muted-foreground/60"
              icon={NeuralNetworkIcon}
            />
            <p className="font-medium text-sm">{t('web.studio.orchestrationEmpty')}</p>
            <p className="text-muted-foreground text-sm">{t('web.studio.orchestrationEmptyHint')}</p>
          </div>
        )}

        {!isLoading && targets.length > 0 && (
          <div className="flex gap-6">
            {/* hub: any agent is a potential caller */}
            <div className="flex shrink-0 flex-col items-center gap-1.5 self-start rounded-lg border bg-card px-4 py-3">
              <HugeiconsIcon
                className="size-5 text-primary"
                icon={UserGroupIcon}
              />
              <span className="font-medium text-sm">{t('web.studio.orchestrationAnyAgent')}</span>
              <HugeiconsIcon
                className="size-4 text-muted-foreground"
                icon={ArrowRight01Icon}
              />
            </div>

            {/* spokes: each delegatable target */}
            <div className="relative flex flex-1 flex-col gap-2 border-l pl-6">
              {targets.map((a) => (
                <div
                  className="relative rounded-lg border bg-card px-4 py-3 before:absolute before:top-1/2 before:left-[-1.5rem] before:h-px before:w-6 before:bg-border"
                  key={a.id}
                >
                  <div className="flex items-center gap-2">
                    <HugeiconsIcon
                      className="size-4 text-muted-foreground"
                      icon={BotIcon}
                    />
                    <span className="font-medium text-sm">{a.name}</span>
                    {a.visibility?.public && <Badge variant="secondary">{t('web.studio.badgePublic')}</Badge>}
                    <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                      {a.model ?? a.modelAlias ?? t('web.studio.modelInherit')}
                    </span>
                  </div>
                  {a.description && <p className="mt-1 line-clamp-2 text-muted-foreground text-xs">{a.description}</p>}
                  <p className="mt-1.5 text-[11px] text-muted-foreground">{toolLabel(a)}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
