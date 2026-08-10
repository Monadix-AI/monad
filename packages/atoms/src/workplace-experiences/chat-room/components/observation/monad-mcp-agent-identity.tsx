import type { Participant } from '../../../experience/types.ts';

import { entityAvatarUrl } from '@monad/protocol';
import { cn } from '@monad/ui';
import { AgentIdentity, Avatar, resolveProductIcon } from '@monad/ui/components/AgentAvatar';

import { avatarForAgent } from '../../../experience/project-projection.ts';

export function MonadMcpAgentIdentity({
  av,
  agentName,
  avatarUrl,
  className,
  icon: iconProp,
  identityClassName,
  name,
  size = 28
}: {
  av?: string;
  agentName?: string;
  avatarUrl?: string;
  className?: string;
  icon?: Participant['icon'];
  identityClassName?: string;
  name: string;
  size?: number;
}) {
  const icon = iconProp ?? resolveProductIcon({ icon: agentName, name });
  return (
    <span
      className={cn('inline-flex min-w-0 items-center gap-2.5', className)}
      data-slot="monad-mcp-agent-identity"
    >
      <Avatar
        av={av ?? avatarForAgent(name)}
        avatarUrl={avatarUrl ?? entityAvatarUrl(`mesh-agent:${agentName ?? name}`)}
        bordered={false}
        icon={icon}
        kind="agent"
        size={size}
      />
      <AgentIdentity
        className={cn('min-w-0 font-medium text-foreground', identityClassName)}
        icon={icon}
        name={name}
      />
    </span>
  );
}
