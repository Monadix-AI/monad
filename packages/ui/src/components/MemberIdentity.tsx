import type { CSSProperties, ReactElement, ReactNode } from 'react';

import { createElement } from 'react';

import { AgentIdentity, AgentInstanceAvatar } from './AgentAvatar';

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
    name: string;
  };
  avatarSize?: number;
  badge?: ReactNode;
  badgeGap?: number;
  bordered?: boolean;
  className?: string;
  nameStyle?: CSSProperties;
}

export function MemberIdentity({
  agent,
  avatarSize = 28,
  badge,
  badgeGap,
  bordered = false,
  className,
  nameStyle
}: MemberIdentityProps): ReactElement {
  return createElement(
    'span',
    {
      className,
      style: { alignItems: 'center', display: 'inline-flex', gap: 8, maxWidth: '100%', minWidth: 0 }
    },
    createElement(AgentInstanceAvatar, { agent, bordered, size: avatarSize }),
    createElement(AgentIdentity, {
      badge,
      badgeGap,
      name: agent.name,
      nameStyle
    })
  );
}
