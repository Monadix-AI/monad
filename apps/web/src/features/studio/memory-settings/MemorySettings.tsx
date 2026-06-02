import {
  JusticeScaleIcon,
  LeftToRightListBulletIcon,
  NeuralNetworkIcon,
  SlidersHorizontalIcon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button, cn, Separator } from '@monad/ui';
import { useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { PanelShell, PanelShellBody } from '#/components/ui/panel-shell';
import { StudioBreadcrumbHeader } from '#/features/studio/StudioBreadcrumbHeader';
import { AgentMemorySettingsSection } from './AgentMemorySettingsSection';
import { BackendSection } from './BackendSection';
import { FactsView } from './FactsView';
import { GraphView } from './GraphView';
import { LawsView } from './LawsView';
import { MemoryDataScopePicker } from './MemoryDataScopePicker';
import { MEMORY_TABS, type MemoryTab } from './memory-settings-state';

export type { MemoryTab } from './memory-settings-state';

interface Props {
  onClose: () => void;
  initialTab?: MemoryTab;
}

export function MemorySettings({ initialTab = 'settings' }: Props) {
  const t = useT();
  const [tab, setTab] = useState<MemoryTab>(initialTab);
  const [dataScope, setDataScope] = useState<OptionalMemoryScopeQuery | undefined>();

  const icons = {
    settings: SlidersHorizontalIcon,
    facts: LeftToRightListBulletIcon,
    graph: NeuralNetworkIcon,
    laws: JusticeScaleIcon
  };
  const labels = {
    settings: t('web.memory.tabSettings'),
    facts: t('web.memory.tabFacts'),
    graph: t('web.memory.tabGraph'),
    laws: t('web.memory.tabLaws')
  };
  return (
    <PanelShell>
      <StudioBreadcrumbHeader
        actions={
          <div className="flex items-center gap-0.5">
            {MEMORY_TABS.map((value) => (
              <Button
                aria-pressed={tab === value}
                className={cn('gap-1.5 text-muted-foreground', tab === value && 'bg-muted text-foreground')}
                key={value}
                onClick={() => setTab(value)}
                size="sm"
                variant="ghost"
              >
                <HugeiconsIcon
                  className="size-4"
                  icon={icons[value]}
                />
                {labels[value]}
              </Button>
            ))}
          </div>
        }
        title={t('web.settings.memory')}
      />

      {tab === 'facts' ? (
        <FactsView />
      ) : tab === 'graph' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex justify-end border-b px-6 py-2">
            <MemoryDataScopePicker
              onChange={setDataScope}
              value={dataScope}
            />
          </div>
          <GraphView scope={dataScope} />
        </div>
      ) : tab === 'laws' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex justify-end border-b px-6 py-2">
            <MemoryDataScopePicker
              onChange={setDataScope}
              value={dataScope}
            />
          </div>
          <LawsView scope={dataScope} />
        </div>
      ) : (
        <PanelShellBody className="flex flex-col gap-6 px-6 py-6">
          <BackendSection />
          <Separator />
          <AgentMemorySettingsSection />
        </PanelShellBody>
      )}
    </PanelShell>
  );
}

import type { OptionalMemoryScopeQuery } from '@monad/protocol';
