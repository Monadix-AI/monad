import type { AgentFlowNodeId } from './agent-flow-model';
import type {
  ChannelsPanelProps,
  IdentityPanelProps,
  MemoryPanelProps,
  ModelsPanelProps,
  SandboxPanelProps,
  SkillsPanelProps,
  ToolsPanelProps
} from './panels/types';

import { Cancel01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button } from '@monad/ui';

import { useT } from '#/components/I18nProvider';
import { AGENT_FLOW_ICON_SRC } from './agent-flow-icons';
import { ChannelsPanel } from './panels/ChannelsPanel';
import { IdentityPanel } from './panels/IdentityPanel';
import { MemoryPanel } from './panels/MemoryPanel';
import { ModelsPanel } from './panels/ModelsPanel';
import { SandboxPanel } from './panels/SandboxPanel';
import { SkillsPanel } from './panels/SkillsPanel';
import { ToolsPanel } from './panels/ToolsPanel';

interface AgentFlowPanelProps {
  channels: ChannelsPanelProps;
  identity: IdentityPanelProps;
  memory: MemoryPanelProps;
  models: ModelsPanelProps;
  onClose: () => void;
  sandbox: SandboxPanelProps;
  selected: AgentFlowNodeId;
  skills: SkillsPanelProps;
  tools: ToolsPanelProps;
}

const PANEL_META = {
  identity: {
    iconSrc: AGENT_FLOW_ICON_SRC.identity,
    key: 'identity'
  },
  models: {
    iconSrc: AGENT_FLOW_ICON_SRC.models,
    key: 'models'
  },
  tools: {
    iconSrc: AGENT_FLOW_ICON_SRC.tools,
    key: 'tools'
  },
  skills: {
    iconSrc: AGENT_FLOW_ICON_SRC.skills,
    key: 'skills'
  },
  memory: {
    iconSrc: AGENT_FLOW_ICON_SRC.memory,
    key: 'memory'
  },
  sandbox: {
    iconSrc: AGENT_FLOW_ICON_SRC.sandbox,
    key: 'sandbox'
  },
  channels: {
    iconSrc: AGENT_FLOW_ICON_SRC.channels,
    key: 'channels'
  }
} as const;

function PanelContent(props: AgentFlowPanelProps) {
  switch (props.selected) {
    case 'identity':
      return <IdentityPanel {...props.identity} />;
    case 'models':
      return <ModelsPanel {...props.models} />;
    case 'tools':
      return <ToolsPanel {...props.tools} />;
    case 'skills':
      return <SkillsPanel {...props.skills} />;
    case 'memory':
      return <MemoryPanel {...props.memory} />;
    case 'sandbox':
      return <SandboxPanel {...props.sandbox} />;
    case 'channels':
      return <ChannelsPanel {...props.channels} />;
  }
}

export function AgentFlowPanel(props: AgentFlowPanelProps) {
  const t = useT();
  const meta = PANEL_META[props.selected];
  const title = t(`web.studio.agentEditor.node.${meta.key}.title`);

  return (
    <aside
      aria-label={title}
      className="absolute top-[190px] right-5 bottom-20 z-20 flex w-[min(480px,calc(100%-2.5rem))] flex-col overflow-hidden rounded-2xl border bg-background shadow-xl max-md:bottom-0 max-md:rounded-b-none max-lg:inset-x-4 max-lg:top-auto max-lg:h-[min(70%,38rem)] max-lg:w-auto"
    >
      <div className="flex items-start gap-3 border-b px-5 py-4">
        <span className="grid size-12 shrink-0 place-items-center">
          {/* biome-ignore lint/performance/noImgElement: Workshop icons are local static assets in this Bun app. */}
          <img
            alt=""
            className="size-12 object-contain"
            draggable={false}
            src={meta.iconSrc}
          />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-medium text-base">{title}</h2>
          <p className="mt-0.5 text-muted-foreground text-xs">{t(`web.studio.agentEditor.node.${meta.key}.hint`)}</p>
        </div>
        <Button
          aria-label={t('web.studio.agentEditor.closeSettings')}
          className="size-8"
          onClick={props.onClose}
          size="icon"
          variant="ghost"
        >
          <HugeiconsIcon icon={Cancel01Icon} />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
        <PanelContent {...props} />
      </div>
    </aside>
  );
}
