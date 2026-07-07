import type { NativeAgentDeliveryId } from '@monad/protocol';
import type { Message } from '../../experience/types.ts';

import { ProductIcon } from '@monad/ui';
import {
  AgentIdentity,
  AgentInstanceAvatar,
  workspaceMono as mono,
  resolveProductIcon,
  TagChip
} from '@monad/ui/components/AgentAvatar';

export const TIME_STYLE: React.CSSProperties = { fontFamily: mono, fontSize: 11, color: 'var(--muted-foreground)' };

const SYSTEM_EVENT_CSS = `
.workplace-system-event {
  max-width: min(620px, 100%);
  display: inline-grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 7px;
  border-radius: 12px;
  background: var(--card);
  color: var(--muted-foreground);
  font-family: var(--font-sans), ui-sans-serif, system-ui, sans-serif;
  font-size: 13px;
  line-height: 1.35;
  padding: 6px 8px;
}

.workplace-system-agent {
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--foreground);
  font-weight: 650;
}

.workplace-system-copy {
  min-width: 0;
  color: var(--muted-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@keyframes workplace-system-pending-pulse {
  0%, 100% { opacity: 0.46; }
  50% { opacity: 0.82; }
}

.workplace-system-pending {
  width: min(420px, 100%);
  display: inline-flex;
  align-items: center;
  gap: 9px;
  border-radius: 12px;
  background: var(--card);
  padding: 8px 10px;
}

.workplace-system-pending-avatar,
.workplace-system-pending-line {
  flex: none;
  background: color-mix(in srgb, var(--muted-foreground) 22%, transparent);
  animation: workplace-system-pending-pulse 1.5s ease-in-out infinite;
}

.workplace-system-pending-avatar {
  width: 22px;
  height: 22px;
  border-radius: 999px;
}

.workplace-system-pending-line {
  height: 9px;
  border-radius: 999px;
}

@media (prefers-reduced-motion: reduce) {
  .workplace-system-pending-avatar,
  .workplace-system-pending-line {
    animation: none;
  }
}

`;

export function SystemMessageRow({
  msg,
  onAgentClick,
  onFollowExternalAgentSession
}: {
  msg: Message;
  onAgentClick?: (id: string) => void;
  onFollowExternalAgentSession?: (id: string, deliveryId?: NativeAgentDeliveryId) => void;
}): React.ReactElement {
  void onFollowExternalAgentSession;
  const developer = msg.kind === 'developer' || msg.developerOnly === true;
  const agentProductIcon = msg.agentChip ? resolveProductIcon(msg.agentChip) : null;
  const pending = msg.systemTone === 'pending';
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        marginBottom: 12
      }}
    >
      <style>{SYSTEM_EVENT_CSS}</style>
      {pending ? (
        <div
          aria-label="Agent response pending"
          className="workplace-system-pending"
          role="status"
        >
          <span className="workplace-system-pending-avatar" />
          <span
            className="workplace-system-pending-line"
            style={{ width: '42%' }}
          />
          <span
            className="workplace-system-pending-line"
            style={{ width: '18%' }}
          />
        </div>
      ) : (
        <div className="workplace-system-event">
          {developer ? <TagChip tag="DEV" /> : null}
          {msg.agentChip ? (
            <button
              className="workplace-action workplace-system-agent"
              onClick={() => onAgentClick?.(msg.agentChip?.id ?? '')}
              style={{ borderRadius: 999, padding: '2px 6px 2px 2px', margin: '-2px -6px -2px -2px' }}
              type="button"
            >
              <AgentInstanceAvatar
                agent={msg.agentChip}
                bordered={false}
                size={22}
              />
              <AgentIdentity
                badge={
                  agentProductIcon ? (
                    <ProductIcon
                      product={agentProductIcon}
                      size={12}
                      title={msg.agentChip.tag}
                    />
                  ) : null
                }
                badgeGap={4}
                name={msg.agentChip.name}
                nameStyle={{ maxWidth: 210, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              />
            </button>
          ) : null}
          {msg.fanoutAgents?.length ? (
            <span className="workplace-system-agent">
              {msg.fanoutAgents.map((agent) => (
                <AgentInstanceAvatar
                  agent={agent}
                  bordered={false}
                  key={agent.id}
                  size={20}
                />
              ))}
            </span>
          ) : null}
          {msg.text ? <span className="workplace-system-copy">{msg.text}</span> : null}
          {msg.time ? <span style={TIME_STYLE}>{msg.time}</span> : null}
        </div>
      )}
    </div>
  );
}
