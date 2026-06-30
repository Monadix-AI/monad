'use client';

import type { LucideIcon } from 'lucide-react';

import { Separator } from '@monad/ui';
import { Boxes, Brain, List, Network, Scale, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { PanelShell, PanelShellHeader } from '@/components/ui/panel-shell';
import { BackendSection } from './BackendSection';
import { ConsolidationSection } from './ConsolidationSection';
import { FactsView } from './FactsView';
import { GraphView } from './GraphView';
import { LawsView } from './LawsView';
import { Mem0Explorer } from './Mem0Explorer';
import { Segmented } from './Segmented';

// The Memory panel is one tab per layer of the memory stack plus a config tab: Settings (backend +
// consolidation), then the four data views — Facts (L1), Graph (L2), Laws (L3), and the mem0 vector
// explorer. Each tab does exactly one thing; configuration and data browsing never share a scroll.
export type MemoryTab = 'settings' | 'facts' | 'graph' | 'laws' | 'mem0';

interface Props {
  onClose: () => void;
  initialTab?: MemoryTab;
}

export function MemorySettings({ initialTab = 'settings' }: Props) {
  const t = useT();
  const [tab, setTab] = useState<MemoryTab>(initialTab);

  const TABS: { value: MemoryTab; label: string; icon: LucideIcon }[] = [
    { value: 'settings', label: t('web.memory.tabSettings'), icon: SlidersHorizontal },
    { value: 'facts', label: t('web.memory.tabFacts'), icon: List },
    { value: 'graph', label: t('web.memory.tabGraph'), icon: Network },
    { value: 'laws', label: t('web.memory.tabLaws'), icon: Scale },
    { value: 'mem0', label: t('web.memory.tabMem0'), icon: Boxes }
  ];

  return (
    <PanelShell>
      <PanelShellHeader
        actions={
          <Segmented
            onChange={setTab}
            options={TABS}
            value={tab}
          />
        }
        icon={<Brain className="size-4 text-muted-foreground" />}
        title={t('web.settings.memory')}
      />

      {tab === 'facts' ? (
        <FactsView />
      ) : tab === 'graph' ? (
        <GraphView />
      ) : tab === 'laws' ? (
        <LawsView />
      ) : tab === 'mem0' ? (
        <Mem0Explorer />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 py-6">
          <BackendSection />
          <Separator />
          <ConsolidationSection />
        </div>
      )}
    </PanelShell>
  );
}
