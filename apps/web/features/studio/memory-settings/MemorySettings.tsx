'use client';

import {
  BoxesIcon,
  BrainIcon,
  JusticeScaleIcon,
  LeftToRightListBulletIcon,
  NeuralNetworkIcon,
  SlidersHorizontalIcon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { Separator } from '@monad/ui';
import { useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { PanelShell } from '@/components/ui/panel-shell';
import { StudioBreadcrumbHeader } from '@/features/studio/StudioBreadcrumbHeader';
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

  const TABS: { value: MemoryTab; label: string; icon: IconSvgElement }[] = [
    { value: 'settings', label: t('web.memory.tabSettings'), icon: SlidersHorizontalIcon },
    { value: 'facts', label: t('web.memory.tabFacts'), icon: LeftToRightListBulletIcon },
    { value: 'graph', label: t('web.memory.tabGraph'), icon: NeuralNetworkIcon },
    { value: 'laws', label: t('web.memory.tabLaws'), icon: JusticeScaleIcon },
    { value: 'mem0', label: t('web.memory.tabMem0'), icon: BoxesIcon }
  ];

  return (
    <PanelShell>
      <StudioBreadcrumbHeader
        actions={
          <Segmented
            onChange={setTab}
            options={TABS}
            value={tab}
          />
        }
        icon={
          <HugeiconsIcon
            className="size-4 text-muted-foreground"
            icon={BrainIcon}
          />
        }
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
