import type { Agent, AvatarStyle } from '@monad/protocol';

import { entityAvatarUrl } from '@monad/protocol';

export function agentCardAvatar(
  agent: Pick<Agent, 'id' | 'name'>,
  avatarStyle?: AvatarStyle
): { avatarUrl: string; name: string } {
  return {
    avatarUrl: entityAvatarUrl(`monad-agent:${agent.id}`, avatarStyle),
    name: agent.name
  };
}
