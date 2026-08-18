import { entityAvatarUrl } from '@monad/protocol';
import { cn } from '@monad/ui';
import { AgentAvatar, AgentIdentity } from '@monad/ui/components/AgentAvatar';

import { AgentProviderBadge } from '../../../components/agent-provider-badge.tsx';
import { avatarForAgent } from '../../../experience/project-projection.ts';
import { useOptionalWorkplaceExperienceHost } from '../../../host-context.tsx';

export function MonadMcpAgentIdentity({
  av,
  agentName,
  avatarUrl,
  className,
  identityClassName,
  name,
  size = 28
}: {
  av?: string;
  agentName?: string;
  avatarUrl?: string;
  className?: string;
  identityClassName?: string;
  name: string;
  size?: number;
}) {
  const identity = useOptionalWorkplaceExperienceHost()?.resolveAgentIdentity({ name: agentName ?? name });
  const resolvedName = identity?.name ?? name;
  return (
    <span
      className={cn('inline-flex min-w-0 items-center gap-2.5', className)}
      data-slot="monad-mcp-agent-identity"
    >
      <AgentAvatar
        agent={{
          av: identity?.av ?? av ?? avatarForAgent(resolvedName),
          avatarUrl: identity?.avatarUrl ?? avatarUrl ?? entityAvatarUrl(`mesh-agent:${agentName ?? name}`),
          name: resolvedName
        }}
        size={size}
      />
      <AgentIdentity
        badge={<AgentProviderBadge icon={identity?.providerIcon} />}
        className={cn('min-w-0 font-medium text-foreground', identityClassName)}
        name={resolvedName}
      />
    </span>
  );
}
