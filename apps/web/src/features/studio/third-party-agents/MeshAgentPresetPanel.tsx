import type { MeshAgentAuthState, MeshAgentPresetView, MeshAgentView } from '@monad/protocol';

import {
  ExternalLinkIcon,
  LoaderPinwheelIcon,
  Plug01Icon,
  Settings02Icon,
  Unlink01Icon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button, cn } from '@monad/ui';

import { BrandIcon } from '#/components/BrandIcon';
import { useT } from '#/components/I18nProvider';
import { MeshAgentPresetSkeleton } from './MeshAgentPresetSkeleton';
import { meshAgentPresetCardState, presetHintKey, presetToView } from './mesh-agent-settings-utils';
import './mesh-agent-preset-panel.css';

export function MeshAgentPresetPanel({
  agents,
  presets,
  authStates,
  checkingAuth,
  connectingAgentName,
  authSessionAgentName,
  connectAgent,
  detecting = false,
  openInstallPage,
  removeAgent,
  setEditingAgent
}: {
  agents: MeshAgentView[];
  presets: MeshAgentPresetView[];
  authStates: Record<string, MeshAgentAuthState | undefined>;
  checkingAuth: Record<string, boolean | undefined>;
  connectingAgentName: string | null;
  authSessionAgentName?: string;
  connectAgent: (agent: MeshAgentView) => void;
  detecting?: boolean;
  openInstallPage: (preset: MeshAgentPresetView) => void;
  removeAgent: (name: string) => Promise<void>;
  setEditingAgent?: (agent: MeshAgentView) => void;
}) {
  const t = useT();
  const isConnectedPreset = (preset: MeshAgentPresetView) =>
    meshAgentPresetCardState({
      preset,
      connectedAgent: agents.find((entry) => entry.name === preset.id),
      statusAuth: authStates[preset.id]
    }).isConnected;
  const connectedPresets = presets.filter(isConnectedPreset);
  const detectedPresets = presets.filter((preset) => preset.installed && !isConnectedPreset(preset));
  const otherPresets = presets.filter((preset) => !preset.installed && !isConnectedPreset(preset));
  const renderPreset = (preset: MeshAgentPresetView) => (
    <MeshAgentPresetRow
      agent={presetToView(preset)}
      authSessionAgentName={authSessionAgentName}
      checkingAuth={checkingAuth[preset.id] === true}
      connectAgent={connectAgent}
      connectedAgent={agents.find((entry) => entry.name === preset.id)}
      connectingAgentName={connectingAgentName}
      key={preset.id}
      openInstallPage={openInstallPage}
      preset={preset}
      removeAgent={removeAgent}
      setEditingAgent={setEditingAgent}
      statusAuth={authStates[preset.id]}
    />
  );

  if (detecting) return <MeshAgentPresetSkeleton />;

  return (
    <div className="mesh-agent-live-v2 mesh-agent-preset-groups">
      <div className="mesh-agent-preset-groups__sections">
        <section
          aria-label={t('web.meshAgent.connected')}
          className="mesh-agent-preset-groups__section"
        >
          <div className="mesh-agent-preset-groups__heading">
            <span>{t('web.meshAgent.connected')}</span>
          </div>
          <div className="mesh-agent-live-v2__list">{connectedPresets.map(renderPreset)}</div>
        </section>
        <section
          aria-label={t('web.meshAgent.detected')}
          className="mesh-agent-preset-groups__section"
        >
          <div className="mesh-agent-preset-groups__heading">
            <span>{t('web.meshAgent.detected')}</span>
          </div>
          <div className="mesh-agent-live-v2__list">{detectedPresets.map(renderPreset)}</div>
        </section>
        <section
          aria-label={t('web.meshAgent.others')}
          className="mesh-agent-preset-groups__section"
        >
          <div className="mesh-agent-preset-groups__heading">
            <span>{t('web.meshAgent.others')}</span>
          </div>
          <div className="mesh-agent-live-v2__list">{otherPresets.map(renderPreset)}</div>
        </section>
      </div>
    </div>
  );
}

function MeshAgentPresetRow({
  preset,
  agent,
  connectedAgent,
  statusAuth,
  checkingAuth,
  connectingAgentName,
  authSessionAgentName,
  connectAgent,
  openInstallPage,
  removeAgent,
  setEditingAgent
}: {
  preset: MeshAgentPresetView;
  agent: MeshAgentView;
  connectedAgent?: MeshAgentView;
  statusAuth?: MeshAgentAuthState;
  checkingAuth: boolean;
  connectingAgentName: string | null;
  authSessionAgentName?: string;
  connectAgent: (agent: MeshAgentView) => void;
  openInstallPage: (preset: MeshAgentPresetView) => void;
  removeAgent: (name: string) => Promise<void>;
  setEditingAgent?: (agent: MeshAgentView) => void;
}) {
  const t = useT();
  const { canDisconnect, isConnected, settingsAgent } = meshAgentPresetCardState({
    preset,
    connectedAgent,
    statusAuth
  });
  const isConnecting = connectingAgentName === agent.name;
  const isBusy = checkingAuth || isConnecting || authSessionAgentName === agent.name;
  return (
    <div
      className={cn('mesh-agent-live-v2__row', isConnected && 'mesh-agent-live-v2__row--connected')}
      title={!preset.installed ? t(presetHintKey(preset.id)) : undefined}
    >
      <span className="mesh-agent-live-v2__logo">
        {preset.icon ? (
          <BrandIcon
            className="size-6"
            icon={preset.icon}
          />
        ) : null}
      </span>
      <span className="mesh-agent-live-v2__main">
        <span className="mesh-agent-live-v2__name">{preset.label}</span>
      </span>
      <span className="mesh-agent-live-v2__actions">
        {isConnected && settingsAgent ? (
          <>
            {canDisconnect && connectedAgent ? (
              <Button
                className="border-transparent"
                disabled={isBusy}
                onClick={() => removeAgent(connectedAgent.name)}
                size="sm"
                type="button"
                variant="ghost"
              >
                <HugeiconsIcon icon={Unlink01Icon} />
                {t('web.meshAgent.disconnect')}
              </Button>
            ) : null}
            {setEditingAgent ? (
              <Button
                className="border-transparent"
                disabled={isBusy}
                onClick={() => setEditingAgent(settingsAgent)}
                size="sm"
                type="button"
                variant="ghost"
              >
                <HugeiconsIcon icon={Settings02Icon} />
                {t('web.settings.title')}
              </Button>
            ) : null}
          </>
        ) : preset.installed ? (
          <Button
            className="border-transparent"
            disabled={isBusy}
            onClick={() => connectAgent(agent)}
            size="sm"
            type="button"
            variant="ghost"
          >
            {isBusy ? (
              <HugeiconsIcon
                className="animate-spin"
                icon={LoaderPinwheelIcon}
              />
            ) : (
              <HugeiconsIcon icon={Plug01Icon} />
            )}
            {checkingAuth || authSessionAgentName === agent.name
              ? t('web.meshAgent.checkingAuth')
              : t('web.meshAgent.connect')}
          </Button>
        ) : (
          <Button
            className="border-transparent"
            onClick={() => openInstallPage(preset)}
            size="sm"
            type="button"
            variant="ghost"
          >
            <HugeiconsIcon icon={ExternalLinkIcon} />
            {t('web.meshAgent.install')}
          </Button>
        )}
      </span>
    </div>
  );
}
