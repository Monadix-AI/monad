import type { Message } from '../../experience/types.ts';

import { ProductIcon, WorkspaceSystemEventCard } from '@monad/ui';
import {
  AgentIdentity,
  AgentInstanceAvatar,
  workspaceMono as mono,
  resolveProductIcon,
  TagChip
} from '@monad/ui/components/AgentAvatar';

export const TIME_STYLE: React.CSSProperties = { fontFamily: mono, fontSize: 11, color: 'var(--muted-foreground)' };

export function SystemMessageRow({
  msg,
  onAgentClick
}: {
  msg: Message;
  onAgentClick?: (id: string) => void;
}): React.ReactElement {
  const developer = msg.kind === 'developer' || msg.developerOnly === true;
  const agentProductIcon = msg.agentChip ? resolveProductIcon(msg.agentChip) : null;
  return (
    <WorkspaceSystemEventCard
      actor={
        msg.agentChip ? (
          <button
            className="workplace-action inline-flex min-w-0 items-center gap-1.5 rounded-full px-1.5 py-0.5 font-semibold text-foreground"
            onClick={() => onAgentClick?.(msg.agentChip?.id ?? '')}
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
        ) : undefined
      }
      badge={developer ? <TagChip tag="DEV" /> : undefined}
      body={msg.text ? <span className="min-w-0 truncate text-muted-foreground">{msg.text}</span> : undefined}
      fanout={
        msg.fanoutAgents?.length ? (
          <span className="inline-flex min-w-0 items-center gap-1.5 text-foreground">
            {msg.fanoutAgents.map((agent) => (
              <AgentInstanceAvatar
                agent={agent}
                bordered={false}
                key={agent.id}
                size={20}
              />
            ))}
          </span>
        ) : undefined
      }
      timestamp={msg.time ? <span style={TIME_STYLE}>{msg.time}</span> : undefined}
    />
  );
}
