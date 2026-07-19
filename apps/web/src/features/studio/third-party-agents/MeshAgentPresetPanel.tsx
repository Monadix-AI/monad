import type { MeshAgentPresetView, MeshAgentView } from '@monad/protocol';

import {
  CircleCheckIcon,
  ExternalLinkIcon,
  LoaderPinwheelIcon,
  Plug01Icon,
  Search01Icon,
  Settings02Icon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button, cn, isProductIconId, ProductIcon } from '@monad/ui';

import { useT } from '#/components/I18nProvider';
import { presetHintKey, presetToView } from './mesh-agent-settings-utils';

export function MeshAgentPresetPanel({
  agents,
  presets,
  authStates,
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
  authStates: Record<string, string | undefined>;
  connectingAgentName: string | null;
  authSessionAgentName?: string;
  connectAgent: (agent: MeshAgentView) => void;
  detecting?: boolean;
  openInstallPage: (preset: MeshAgentPresetView) => void;
  removeAgent: (name: string) => Promise<void>;
  setEditingAgent?: (agent: MeshAgentView) => void;
}) {
  const t = useT();

  return (
    <div className="mesh-agent-live-v2">
      <style>{`
        .mesh-agent-live-v2 {
          display: grid;
          grid-template-columns: minmax(160px, 0.72fr) minmax(0, 1.9fr);
          gap: 14px;
          border: 1px solid var(--border);
          border-radius: 10px;
          background: color-mix(in srgb, var(--muted) 54%, transparent);
          padding: 12px;
        }

        .mesh-agent-live-v2__header {
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding: 2px 4px;
        }

        .mesh-agent-live-v2__header > span {
          font-size: 13px;
          font-weight: 650;
        }

        .mesh-agent-live-v2 p {
          margin: 0;
          color: var(--muted-foreground);
          font-size: 12px;
          line-height: 1.45;
        }

        .mesh-agent-live-v2__list {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .mesh-agent-live-v2__row {
          display: grid;
          grid-template-columns: 34px minmax(0, 1fr) auto;
          align-items: center;
          gap: 10px;
          min-height: 54px;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: var(--card);
          padding: 8px 9px;
        }

        .mesh-agent-live-v2__logo {
          display: grid;
          place-items: center;
          width: 34px;
          height: 34px;
          border: 1px solid var(--border);
          border-radius: 7px;
          background: var(--background);
        }

        .mesh-agent-live-v2__main {
          display: flex;
          min-width: 0;
          flex-direction: column;
          gap: 2px;
        }

        .mesh-agent-live-v2__name {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 13px;
          font-weight: 650;
        }

        .mesh-agent-live-v2__actions {
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .mesh-agent-live-v2__row--connected {
          background: var(--card);
        }

        .mesh-agent-live-v2__row--connected .mesh-agent-live-v2__logo {
          border-color: color-mix(in srgb, var(--success) 28%, var(--border));
          box-shadow: 0 0 0 5px color-mix(in srgb, var(--success) 12%, transparent);
        }

        .mesh-agent-live-v2__status {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          border-radius: 999px;
          padding: 3px 8px;
          font-size: 12px;
          font-weight: 650;
        }

        .mesh-agent-live-v2__status--connected {
          background: color-mix(in srgb, var(--success) 12%, transparent);
          color: color-mix(in srgb, var(--success) 55%, var(--foreground));
        }

        .mesh-agent-live-v2__status--detected {
          background: color-mix(in srgb, var(--info) 13%, transparent);
          color: color-mix(in srgb, var(--info) 65%, var(--foreground));
        }

        .mesh-agent-live-v2__status--missing {
          background: color-mix(in srgb, var(--warning) 12%, transparent);
          color: color-mix(in srgb, var(--warning) 68%, var(--foreground));
        }

        @media (max-width: 760px) {
          .mesh-agent-live-v2 {
            grid-template-columns: 1fr;
          }

          .mesh-agent-live-v2__row {
            grid-template-columns: 34px minmax(0, 1fr);
          }

          .mesh-agent-live-v2__actions {
            grid-column: 2;
          }
        }
      `}</style>
      <div className="mesh-agent-live-v2__header">
        <span>{t('web.meshAgent.invite')}</span>
        <p>{t('web.meshAgent.inviteHint')}</p>
      </div>
      <div className="mesh-agent-live-v2__list">
        {presets.map((preset) => (
          <MeshAgentPresetRow
            agent={presetToView(preset)}
            authSessionAgentName={authSessionAgentName}
            connectAgent={connectAgent}
            connectedAgent={agents.find((entry) => entry.name === preset.id)}
            connectingAgentName={connectingAgentName}
            detecting={detecting}
            key={preset.id}
            openInstallPage={openInstallPage}
            preset={preset}
            removeAgent={removeAgent}
            setEditingAgent={setEditingAgent}
            statusAuth={authStates[preset.id]}
          />
        ))}
      </div>
    </div>
  );
}

function MeshAgentPresetRow({
  preset,
  agent,
  connectedAgent,
  statusAuth,
  connectingAgentName,
  authSessionAgentName,
  connectAgent,
  detecting,
  openInstallPage,
  removeAgent,
  setEditingAgent
}: {
  preset: MeshAgentPresetView;
  agent: MeshAgentView;
  connectedAgent?: MeshAgentView;
  statusAuth?: string;
  connectingAgentName: string | null;
  authSessionAgentName?: string;
  connectAgent: (agent: MeshAgentView) => void;
  detecting: boolean;
  openInstallPage: (preset: MeshAgentPresetView) => void;
  removeAgent: (name: string) => Promise<void>;
  setEditingAgent?: (agent: MeshAgentView) => void;
}) {
  const t = useT();
  const isConnected = preset.installed && statusAuth === 'authenticated' && connectedAgent;
  const isConnecting = connectingAgentName === agent.name;
  const checkingAuth = isConnecting || authSessionAgentName === agent.name;
  const status = detecting
    ? 'detecting'
    : checkingAuth
      ? 'checking'
      : isConnected
        ? 'connected'
        : preset.installed
          ? 'detected'
          : 'missing';
  return (
    <div
      className={cn('mesh-agent-live-v2__row', status === 'connected' && 'mesh-agent-live-v2__row--connected')}
      title={status === 'missing' ? t(presetHintKey(preset.id)) : undefined}
    >
      <span className="mesh-agent-live-v2__logo">
        {isProductIconId(preset.productIcon) ? (
          <ProductIcon
            className="size-6"
            product={preset.productIcon}
          />
        ) : null}
      </span>
      <span className="mesh-agent-live-v2__main">
        <span className="mesh-agent-live-v2__name">{preset.label}</span>
      </span>
      <span className="mesh-agent-live-v2__actions">
        {status === 'detecting' ? (
          <StatusPill
            icon={LoaderPinwheelIcon}
            iconClassName="size-3.5 animate-spin"
            label="Detecting..."
            tone="detected"
          />
        ) : status === 'checking' ? (
          <StatusPill
            icon={LoaderPinwheelIcon}
            iconClassName="size-3.5 animate-spin"
            label={t('web.meshAgent.checkingAuth')}
            tone="detected"
          />
        ) : status === 'connected' && connectedAgent ? (
          <>
            <StatusPill
              icon={CircleCheckIcon}
              label={t('web.meshAgent.connected')}
              tone="connected"
            />
            {setEditingAgent ? (
              <Button
                aria-label={`Settings for ${connectedAgent.name}`}
                className="border-transparent"
                onClick={() => setEditingAgent(connectedAgent)}
                size="sm"
                type="button"
                variant="ghost"
              >
                <HugeiconsIcon icon={Settings02Icon} />
                {t('web.settings.title')}
              </Button>
            ) : null}
            <Button
              className="border-transparent"
              onClick={() => removeAgent(connectedAgent.name)}
              size="sm"
              type="button"
              variant="ghost"
            >
              <HugeiconsIcon icon={Plug01Icon} />
              {t('web.meshAgent.disconnect')}
            </Button>
          </>
        ) : status === 'detected' ? (
          <>
            <StatusPill
              icon={Search01Icon}
              label={t('web.meshAgent.detected')}
              tone="detected"
            />
            <Button
              className="border-transparent"
              disabled={isConnecting}
              onClick={() => connectAgent(agent)}
              size="sm"
              type="button"
              variant="ghost"
            >
              {isConnecting ? (
                <HugeiconsIcon
                  className="animate-spin"
                  icon={LoaderPinwheelIcon}
                />
              ) : (
                <HugeiconsIcon icon={Plug01Icon} />
              )}
              {t('web.meshAgent.connect')}
            </Button>
          </>
        ) : (
          <>
            <StatusPill
              icon={Search01Icon}
              label={t('web.meshAgent.notDetected')}
              tone="missing"
            />
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
          </>
        )}
      </span>
    </div>
  );
}

function StatusPill({
  icon,
  iconClassName = 'size-3.5',
  label,
  tone
}: {
  icon: typeof CircleCheckIcon;
  iconClassName?: string;
  label: string;
  tone: 'connected' | 'detected' | 'missing';
}) {
  return (
    <span className={`mesh-agent-live-v2__status mesh-agent-live-v2__status--${tone}`}>
      <HugeiconsIcon
        className={iconClassName}
        icon={icon}
      />
      {label}
    </span>
  );
}
