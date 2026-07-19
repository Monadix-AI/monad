import type { CSSProperties, ReactNode } from 'react';
import type { ProductIconId } from './ProductIcon';

import { createElement } from 'react';

import { isProductIconId, ProductIcon } from './ProductIcon';

export type AgentAvatarIcon = ProductIconId | 'monad' | string;
export type AgentAvatarKind = 'human' | 'agent';
export type AgentPresence = 'online' | 'working' | 'idle' | 'needs-login' | 'failed' | 'stopped';

export const workspaceSans = 'var(--font-sans), ui-sans-serif, system-ui, sans-serif';
export const workspaceMono = 'var(--font-mono), ui-monospace, monospace';
export const workspaceBoxRadius = '12px';

export const workspaceSectionLabelStyle: CSSProperties = {
  fontFamily: workspaceMono,
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: 1.2,
  color: 'var(--muted-foreground)',
  textTransform: 'uppercase'
};

export function agentPresenceColor(presence: AgentPresence): string {
  if (presence === 'online') return 'var(--success)';
  if (presence === 'working') return 'var(--accent-blue)';
  if (presence === 'needs-login') return 'var(--warning, #f59e0b)';
  if (presence === 'failed') return 'var(--destructive)';
  if (presence === 'stopped') return 'var(--muted-foreground)';
  return 'var(--muted-foreground)';
}

export function Avatar({
  av,
  icon,
  avatarUrl,
  kind,
  size = 34,
  bare = false,
  bordered = true
}: {
  av: string;
  icon?: AgentAvatarIcon;
  avatarUrl?: string;
  kind: AgentAvatarKind;
  size?: number;
  bare?: boolean;
  bordered?: boolean;
}): React.ReactElement {
  const agent = kind === 'agent';
  const avatarBackground = agent
    ? 'color-mix(in srgb, var(--accent-blue) 24%, var(--background))'
    : 'color-mix(in srgb, var(--accent-blue) 18%, var(--secondary))';
  const style: CSSProperties = {
    flex: 'none',
    width: size,
    height: size,
    border: bordered && !bare ? `1.5px solid ${agent ? 'var(--accent-blue)' : 'var(--border)'}` : 'none',
    borderRadius: '50%',
    background: bare ? 'transparent' : avatarBackground,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: workspaceMono,
    fontSize: Math.max(9, Math.round(size * 0.33)),
    overflow: 'hidden',
    position: 'relative'
  };
  const child = avatarUrl
    ? [
        createElement('span', { 'aria-hidden': true, key: 'fallback' }, av),
        createElement('img', {
          'aria-hidden': true,
          alt: '',
          key: 'image',
          onError: (event: React.SyntheticEvent<HTMLImageElement>) => {
            event.currentTarget.hidden = true;
          },
          src: avatarUrl,
          style: {
            borderRadius: '50%',
            height: '100%',
            inset: 0,
            objectFit: 'cover',
            position: 'absolute',
            width: '100%'
          }
        })
      ]
    : icon === 'monad'
      ? createElement('span', {
          'aria-label': 'Monad',
          role: 'img',
          style: {
            width: Math.round(size * 0.58),
            height: Math.round(size * 0.58),
            WebkitMaskImage: 'url("/monad-icon-vector-solid.svg")',
            maskImage: 'url("/monad-icon-vector-solid.svg")',
            WebkitMaskRepeat: 'no-repeat',
            maskRepeat: 'no-repeat',
            WebkitMaskPosition: 'center',
            maskPosition: 'center',
            WebkitMaskSize: 'contain',
            maskSize: 'contain',
            background: 'currentColor'
          }
        })
      : icon && isProductIconId(icon)
        ? createElement(ProductIcon, { product: icon, size: Math.round(size * 0.72) })
        : av;
  return createElement('div', { style }, child);
}

export function AgentInstanceAvatar({
  agent,
  bare,
  bordered,
  size = 34
}: {
  agent: {
    av?: string;
    avatarUrl?: string;
    icon?: AgentAvatarIcon;
    name: string;
  };
  bare?: boolean;
  bordered?: boolean;
  size?: number;
}): React.ReactElement {
  return createElement(Avatar, {
    av: agent.av ?? agent.name.slice(0, 2).toUpperCase(),
    avatarUrl: agent.avatarUrl,
    bare,
    bordered,
    icon: agent.icon,
    kind: 'agent',
    size
  });
}

export function TagChip({ tag }: { tag: string }): React.ReactElement {
  const isAgent = tag === 'AI' || tag === 'BOT';
  return createElement(
    'span',
    {
      style: {
        fontFamily: workspaceMono,
        fontSize: 9,
        color: isAgent ? 'var(--foreground)' : 'var(--muted-foreground)',
        border: `1px solid ${isAgent ? 'var(--accent-blue)' : 'var(--border)'}`,
        background: isAgent ? 'var(--accent-blue-soft)' : 'transparent',
        borderRadius: 5,
        padding: '1px 5px'
      }
    },
    tag
  );
}

export function MiniTag({ tag }: { tag: string }): React.ReactElement {
  return createElement(
    'span',
    {
      style: {
        fontFamily: workspaceMono,
        fontSize: 8,
        color: 'var(--foreground)',
        border: `1px solid ${'var(--accent-blue)'}`,
        borderRadius: 4,
        padding: '0 4px'
      }
    },
    tag
  );
}

export function resolveProductIcon(agent: { icon?: string; tag?: string; name: string }): ProductIconId | undefined {
  if (isProductIconId(agent.icon)) return agent.icon;
  const haystack = `${agent.tag ?? ''} ${agent.name}`.toLowerCase();
  if (haystack.includes('codex')) return 'codex';
  if (haystack.includes('claude')) return 'claude-code';
  if (haystack.includes('gemini')) return 'gemini';
  if (haystack.includes('qwen')) return 'qwen';
  return undefined;
}

export function AgentIdentity({
  name,
  badge,
  badgeGap = 8,
  className,
  nameStyle
}: {
  name: string;
  badge?: ReactNode;
  badgeGap?: number;
  className?: string;
  nameStyle?: CSSProperties;
}): React.ReactElement {
  return createElement(
    'span',
    { className, style: { display: 'inline-flex', alignItems: 'center', minWidth: 0 } },
    createElement(
      'span',
      {
        style: {
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          ...nameStyle
        },
        title: name
      },
      name
    ),
    badge
      ? createElement(
          'span',
          { style: { flex: 'none', marginLeft: badgeGap, display: 'inline-flex', alignItems: 'center' } },
          badge
        )
      : null
  );
}

export function PresenceDot({ presence, size = 8 }: { presence: AgentPresence; size?: number }): React.ReactElement {
  return createElement('span', {
    style: {
      width: size,
      height: size,
      borderRadius: '50%',
      background: agentPresenceColor(presence),
      display: 'inline-block',
      flex: 'none'
    }
  });
}

export function PresenceBadge({ presence }: { presence: AgentPresence }): React.ReactElement {
  return createElement('span', {
    style: {
      position: 'absolute',
      right: -2,
      bottom: -2,
      width: 10,
      height: 10,
      borderRadius: '50%',
      border: `2px solid ${'var(--muted)'}`,
      background: agentPresenceColor(presence)
    }
  });
}

export function inkButtonStyle(extra?: CSSProperties): CSSProperties {
  return {
    border: `1px solid ${'var(--accent-blue)'}`,
    borderRadius: workspaceBoxRadius,
    background: 'var(--accent-blue)',
    color: 'var(--primary-foreground)',
    fontFamily: workspaceSans,
    fontWeight: 600,
    ...extra
  };
}

export function ghostButtonStyle(extra?: CSSProperties): CSSProperties {
  return {
    border: `1px solid ${'var(--border)'}`,
    borderRadius: workspaceBoxRadius,
    background: 'var(--card)',
    color: 'var(--foreground)',
    fontFamily: workspaceSans,
    fontWeight: 500,
    ...extra
  };
}
