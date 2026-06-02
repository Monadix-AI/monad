import { useT } from '#/components/I18nProvider';
import './mesh-agent-preset-panel.css';

const groups = [
  {
    actionKeys: ['disconnect', 'settings'],
    id: 'connected',
    labelKey: 'web.meshAgent.connected',
    rowKeys: ['connected-a', 'connected-b', 'connected-c', 'connected-d', 'connected-e']
  },
  {
    actionKeys: ['connect'],
    id: 'detected',
    labelKey: 'web.meshAgent.detected',
    rowKeys: ['detected-a']
  },
  {
    actionKeys: ['install'],
    id: 'others',
    labelKey: 'web.meshAgent.others',
    rowKeys: ['others-a']
  }
] as const;

export function MeshAgentPresetSkeleton() {
  const t = useT();

  return (
    <div
      aria-busy="true"
      className="mesh-agent-live-v2 mesh-agent-preset-groups mesh-agent-preset-groups--loading"
    >
      <div className="mesh-agent-preset-groups__sections">
        {groups.map((group) => (
          <section
            aria-label={t(group.labelKey)}
            className="mesh-agent-preset-groups__section"
            key={group.id}
          >
            <div className="mesh-agent-preset-groups__heading">
              <span>{t(group.labelKey)}</span>
            </div>
            <div className="mesh-agent-live-v2__list">
              {group.rowKeys.map((rowKey) => (
                <div
                  aria-hidden="true"
                  className="mesh-agent-live-v2__row"
                  key={rowKey}
                >
                  <span className="mesh-agent-live-v2__logo mesh-agent-preset-skeleton__block" />
                  <span className="mesh-agent-live-v2__main">
                    <span className="mesh-agent-preset-skeleton__block mesh-agent-preset-skeleton__name" />
                  </span>
                  <span className="mesh-agent-live-v2__actions">
                    {group.actionKeys.map((actionKey) => (
                      <span
                        className="mesh-agent-preset-skeleton__action mesh-agent-preset-skeleton__block"
                        key={`${rowKey}-${actionKey}`}
                      />
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
