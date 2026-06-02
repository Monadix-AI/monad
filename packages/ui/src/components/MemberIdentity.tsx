import type { CSSProperties, ReactElement, ReactNode } from 'react';
import type { AgentAvatarIcon } from './AgentAvatar';

import { createElement } from 'react';

import { AgentIdentity, AgentInstanceAvatar, TagChip } from './AgentAvatar';

export function agentProviderTag(provider: string | undefined): string {
  if (provider === 'codex') return 'Codex';
  if (provider === 'claude-code') return 'Claude';
  if (provider === 'antigravity') return 'Antigravity';
  if (provider === 'gemini') return 'Gemini';
  if (provider === 'qwen') return 'Qwen';
  if (provider === 'openclaw') return 'OpenClaw';
  if (provider === 'hermes') return 'Hermes';
  return 'CLI';
}

export interface MemberIdentityProps {
  agent: {
    av?: string;
    avatarUrl?: string;
    icon?: AgentAvatarIcon;
    name: string;
  };
  avatarSize?: number;
  badge?: ReactNode;
  badgeGap?: number;
  bordered?: boolean;
  className?: string;
  nameStyle?: CSSProperties;
  tag?: string;
}

export function MemberIdentity({
  agent,
  avatarSize = 28,
  badge,
  badgeGap,
  bordered = false,
  className,
  nameStyle,
  tag
}: MemberIdentityProps): ReactElement {
  return createElement(
    'span',
    {
      className,
      style: { alignItems: 'center', display: 'inline-flex', gap: 8, maxWidth: '100%', minWidth: 0 }
    },
    createElement(AgentInstanceAvatar, { agent, bordered, size: avatarSize }),
    createElement(AgentIdentity, {
      badge: badge ?? (!agent.icon && tag ? createElement(TagChip, { tag }) : undefined),
      badgeGap,
      icon: agent.icon,
      name: agent.name,
      nameStyle
    })
  );
}
