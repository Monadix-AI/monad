import type { NativeCliAgentPresetView, NativeCliAgentView } from '@monad/protocol';

import {
  CircleCheckIcon,
  ExternalLinkIcon,
  FileInputIcon,
  LoaderPinwheelIcon,
  Plug01Icon,
  Search01Icon,
  Settings02Icon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button, cn, isProductIconId, ProductIcon } from '@monad/ui';

import { useT } from '@/components/I18nProvider';
import { presetHintKey, presetToView } from './native-cli-agent-settings-utils';

export function NativeCliPresetPanel({
  agents,
  presets,
  authStates,
  connectingAgentName,
  authSessionAgentName,
  connectAgent,
  openInstallPage,
  removeAgent,
  setEditingAgent,
  setImportPreset
}: {
  agents: NativeCliAgentView[];
  presets: NativeCliAgentPresetView[];
  authStates: Record<string, string | undefined>;
  connectingAgentName: string | null;
  authSessionAgentName?: string;
  connectAgent: (agent: NativeCliAgentView) => void;
  openInstallPage: (preset: NativeCliAgentPresetView) => void;
  removeAgent: (name: string) => Promise<void>;
  setEditingAgent: (agent: NativeCliAgentView) => void;
  setImportPreset: (preset: NativeCliAgentPresetView) => void;
}) {
  const t = useT();

  return (
    <div className="native-cli-live-v2">
      <style>{`
        .native-cli-live-v2 {
          display: grid;
          grid-template-columns: minmax(160px, 0.72fr) minmax(0, 1.9fr);
          gap: 14px;
          border: 1px solid var(--border);
          border-radius: 10px;
          background: color-mix(in srgb, var(--muted) 54%, transparent);
          padding: 12px;
        }

        .native-cli-live-v2__header {
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding: 2px 4px;
        }

        .native-cli-live-v2__header > span {
          font-size: 13px;
          font-weight: 650;
        }

        .native-cli-live-v2 p {
          margin: 0;
          color: var(--muted-foreground);
          font-size: 12px;
          line-height: 1.45;
        }

        .native-cli-live-v2__list {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .native-cli-live-v2__row {
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

        .native-cli-live-v2__logo {
          display: grid;
          place-items: center;
          width: 34px;
          height: 34px;
          border: 1px solid var(--border);
          border-radius: 7px;
          background: var(--background);
        }

        .native-cli-live-v2__main {
          display: flex;
          min-width: 0;
          flex-direction: column;
          gap: 2px;
        }

        .native-cli-live-v2__name {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 13px;
          font-weight: 650;
        }

        .native-cli-live-v2__actions {
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .native-cli-live-v2__row--connected {
          background: var(--card);
        }

        .native-cli-live-v2__row--connected .native-cli-live-v2__logo {
          border-color: color-mix(in srgb, var(--success) 28%, var(--border));
          box-shadow: 0 0 0 5px color-mix(in srgb, var(--success) 12%, transparent);
        }

        .native-cli-live-v2__status {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          border-radius: 999px;
          padding: 3px 8px;
          font-size: 12px;
          font-weight: 650;
        }

        .native-cli-live-v2__status--connected {
          background: color-mix(in srgb, var(--success) 12%, transparent);
          color: color-mix(in srgb, var(--success) 55%, var(--foreground));
        }

        .native-cli-live-v2__status--detected {
          background: color-mix(in srgb, var(--info) 13%, transparent);
          color: color-mix(in srgb, var(--info) 65%, var(--foreground));
        }

        .native-cli-live-v2__status--missing {
          background: color-mix(in srgb, var(--warning) 12%, transparent);
          color: color-mix(in srgb, var(--warning) 68%, var(--foreground));
        }

        @media (max-width: 760px) {
          .native-cli-live-v2 {
            grid-template-columns: 1fr;
          }

          .native-cli-live-v2__row {
            grid-template-columns: 34px minmax(0, 1fr);
          }

          .native-cli-live-v2__actions {
            grid-column: 2;
          }
        }
      `}</style>
      <div className="native-cli-live-v2__header">
        <span>{t('web.nativeCli.invite')}</span>
        <p>{t('web.nativeCli.inviteHint')}</p>
      </div>
      <div className="native-cli-live-v2__list">
        {presets.map((preset) => (
          <NativeCliPresetRow
            agent={presetToView(preset)}
            authSessionAgentName={authSessionAgentName}
            connectAgent={connectAgent}
            connectedAgent={agents.find((entry) => entry.name === preset.id)}
            connectingAgentName={connectingAgentName}
            key={preset.id}
            openInstallPage={openInstallPage}
            preset={preset}
            removeAgent={removeAgent}
            setEditingAgent={setEditingAgent}
            setImportPreset={setImportPreset}
            statusAuth={authStates[preset.id]}
          />
        ))}
      </div>
    </div>
  );
}

function NativeCliPresetRow({
  preset,
  agent,
  connectedAgent,
  statusAuth,
  connectingAgentName,
  authSessionAgentName,
  connectAgent,
  openInstallPage,
  removeAgent,
  setEditingAgent,
  setImportPreset
}: {
  preset: NativeCliAgentPresetView;
  agent: NativeCliAgentView;
  connectedAgent?: NativeCliAgentView;
  statusAuth?: string;
  connectingAgentName: string | null;
  authSessionAgentName?: string;
  connectAgent: (agent: NativeCliAgentView) => void;
  openInstallPage: (preset: NativeCliAgentPresetView) => void;
  removeAgent: (name: string) => Promise<void>;
  setEditingAgent: (agent: NativeCliAgentView) => void;
  setImportPreset: (preset: NativeCliAgentPresetView) => void;
}) {
  const t = useT();
  const isConnected = preset.installed && statusAuth === 'authenticated' && connectedAgent;
  const isConnecting = connectingAgentName === agent.name;
  const checkingAuth = isConnecting || authSessionAgentName === agent.name;
  const status = checkingAuth ? 'checking' : isConnected ? 'connected' : preset.installed ? 'detected' : 'missing';
  const canImportSettings = preset.capabilities?.settingsImport === true;

  return (
    <div
      className={cn('native-cli-live-v2__row', status === 'connected' && 'native-cli-live-v2__row--connected')}
      title={status === 'missing' ? t(presetHintKey(preset.id)) : undefined}
    >
      <span className="native-cli-live-v2__logo">
        {isProductIconId(preset.productIcon) ? (
          <ProductIcon
            className="size-6"
            product={preset.productIcon}
          />
        ) : null}
      </span>
      <span className="native-cli-live-v2__main">
        <span className="native-cli-live-v2__name">{preset.label}</span>
      </span>
      <span className="native-cli-live-v2__actions">
        {status === 'checking' ? (
          <StatusPill
            icon={LoaderPinwheelIcon}
            iconClassName="size-3.5 animate-spin"
            label={t('web.nativeCli.checkingAuth')}
            tone="detected"
          />
        ) : status === 'connected' && connectedAgent ? (
          <>
            <StatusPill
              icon={CircleCheckIcon}
              label={t('web.nativeCli.connected')}
              tone="connected"
            />
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
            {canImportSettings ? <ImportButton onClick={() => setImportPreset(preset)} /> : null}
            <Button
              className="border-transparent"
              onClick={() => removeAgent(connectedAgent.name)}
              size="sm"
              type="button"
              variant="ghost"
            >
              <HugeiconsIcon icon={Plug01Icon} />
              {t('web.nativeCli.disconnect')}
            </Button>
          </>
        ) : status === 'detected' ? (
          <>
            <StatusPill
              icon={Search01Icon}
              label={t('web.nativeCli.detected')}
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
              {t('web.nativeCli.connect')}
            </Button>
            {canImportSettings ? <ImportButton onClick={() => setImportPreset(preset)} /> : null}
          </>
        ) : (
          <>
            <StatusPill
              icon={Search01Icon}
              label={t('web.nativeCli.notDetected')}
              tone="missing"
            />
            {canImportSettings ? <ImportButton onClick={() => setImportPreset(preset)} /> : null}
            <Button
              className="border-transparent"
              onClick={() => openInstallPage(preset)}
              size="sm"
              type="button"
              variant="ghost"
            >
              <HugeiconsIcon icon={ExternalLinkIcon} />
              {t('web.nativeCli.install')}
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
    <span className={`native-cli-live-v2__status native-cli-live-v2__status--${tone}`}>
      <HugeiconsIcon
        className={iconClassName}
        icon={icon}
      />
      {label}
    </span>
  );
}

function ImportButton({ onClick }: { onClick: () => void }) {
  const t = useT();

  return (
    <Button
      className="border-transparent"
      onClick={onClick}
      size="sm"
      type="button"
      variant="ghost"
    >
      <HugeiconsIcon icon={FileInputIcon} />
      {t('web.nativeCli.importSettings')}
    </Button>
  );
}
