'use client';

import { ScrollArea } from '@monad/ui';
import { Brain, Eye, GripVertical, Package, Plug, ShieldHalf, Sparkles, Wrench } from 'lucide-react';

import { useT } from '@/components/I18nProvider';
import { type CapabilityItem, PartCard, serializePayload, type WorkshopPart } from './AgentWorkshopPrimitives';

interface AgentWorkshopPartsBinProps {
  capabilityCatalog: CapabilityItem[];
  mountCapability: (name: string) => void;
  selectedPart: WorkshopPart;
  setDraggingPart: (part: WorkshopPart | null) => void;
  setSelectedPart: (part: WorkshopPart) => void;
}

export function AgentWorkshopPartsBin({
  capabilityCatalog,
  mountCapability,
  selectedPart,
  setDraggingPart,
  setSelectedPart
}: AgentWorkshopPartsBinProps) {
  const t = useT();

  return (
    <ScrollArea className="border-r">
      <div className="flex flex-col gap-5 p-4">
        <div>
          <div className="mb-2 px-1 text-[11px] text-muted-foreground uppercase tracking-[0.24em]">
            {t('web.studio.workshopPartsBin')}
          </div>
          <div className="flex flex-col gap-3">
            <PartCard
              body={t('web.studio.workshopBrainHint')}
              icon={Brain}
              onDragEnd={() => setDraggingPart(null)}
              onSelect={() => setSelectedPart('brain')}
              onStartDrag={() => setDraggingPart('brain')}
              part="brain"
              selected={selectedPart === 'brain'}
              title={t('web.studio.workshopBrain')}
            />
            <PartCard
              body={t('web.studio.workshopPromptHint')}
              icon={Sparkles}
              onDragEnd={() => setDraggingPart(null)}
              onSelect={() => setSelectedPart('prompt')}
              onStartDrag={() => setDraggingPart('prompt')}
              part="prompt"
              selected={selectedPart === 'prompt'}
              title={t('web.studio.workshopPrompt')}
            />
            <PartCard
              body={t('web.studio.workshopToolsHint')}
              icon={Wrench}
              onDragEnd={() => setDraggingPart(null)}
              onSelect={() => setSelectedPart('tools')}
              onStartDrag={() => setDraggingPart('tools')}
              part="tools"
              selected={selectedPart === 'tools'}
              title={t('web.studio.workshopTools')}
            />
            <PartCard
              body={t('web.studio.workshopSafetyHint')}
              icon={ShieldHalf}
              onDragEnd={() => setDraggingPart(null)}
              onSelect={() => setSelectedPart('safety')}
              onStartDrag={() => setDraggingPart('safety')}
              part="safety"
              selected={selectedPart === 'safety'}
              title={t('web.studio.workshopSafety')}
            />
            <PartCard
              body={t('web.studio.workshopVisibilityHint')}
              icon={Eye}
              onDragEnd={() => setDraggingPart(null)}
              onSelect={() => setSelectedPart('visibility')}
              onStartDrag={() => setDraggingPart('visibility')}
              part="visibility"
              selected={selectedPart === 'visibility'}
              title={t('web.studio.workshopVisibility')}
            />
          </div>
        </div>

        <div>
          <div className="mb-2 px-1 text-[11px] text-muted-foreground uppercase tracking-[0.24em]">
            {t('web.studio.workshopCapabilities')}
          </div>
          <div className="flex flex-col gap-2">
            {capabilityCatalog.length === 0 ? (
              <div className="rounded-2xl border border-dashed px-4 py-6 text-center text-muted-foreground text-xs">
                {t('web.studio.atomsEmpty')}
              </div>
            ) : (
              capabilityCatalog.map((capability) => (
                <button
                  className="flex w-full items-center gap-3 rounded-2xl border bg-card/80 px-3 py-3 text-left transition hover:border-primary/40"
                  draggable
                  key={capability.name}
                  onClick={() => mountCapability(capability.name)}
                  onDragEnd={() => setDraggingPart(null)}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'copyMove';
                    event.dataTransfer.setData(
                      'application/json',
                      serializePayload({
                        type: 'capability',
                        name: capability.name,
                        sourceKind: capability.sourceKind
                      })
                    );
                    setDraggingPart('tools');
                  }}
                  type="button"
                >
                  <span className="flex size-8 items-center justify-center rounded-xl bg-secondary text-secondary-foreground">
                    {capability.sourceKind === 'atom' ? <Package className="size-4" /> : <Plug className="size-4" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-sm">{capability.name}</span>
                    <span className="block truncate text-muted-foreground text-xs">{capability.detail}</span>
                  </span>
                  <GripVertical className="size-3.5 text-muted-foreground" />
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </ScrollArea>
  );
}
