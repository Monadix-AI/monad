import type { ProductIconId } from '@monad/ui';
import type { CSSProperties, ReactNode } from 'react';
import type { Participant, ParticipantKind, Presence } from './types';

import { isProductIconId, ProductIcon } from '@monad/ui';

import { providerLogo } from '@/lib/ProviderMeta';
import { boxR, mono, presenceColor, sans } from './styles';

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
  icon?: Participant['icon'];
  avatarUrl?: string;
  kind: ParticipantKind;
  size?: number;
  bare?: boolean;
  bordered?: boolean;
}): React.ReactElement {
  const agent = kind === 'agent';
  const ProviderLogo = icon && icon !== 'monad' && !isProductIconId(icon) ? providerLogo(icon).logo : null;
  const style: CSSProperties = {
    flex: 'none',
    width: size,
    height: size,
    border: bordered && !bare ? `1.5px solid ${agent ? 'var(--accent-blue)' : 'var(--border)'}` : 'none',
    borderRadius: '50%',
    background: bare ? 'transparent' : agent ? 'var(--accent-blue-soft)' : 'var(--secondary)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: mono,
    fontSize: Math.max(9, Math.round(size * 0.33))
  };
  return (
    <div style={style}>
      {avatarUrl ? (
        <span
          aria-hidden="true"
          style={{
            width: '100%',
            height: '100%',
            borderRadius: '50%',
            backgroundImage: `url("${avatarUrl}")`,
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
            backgroundSize: 'cover'
          }}
        />
      ) : icon === 'monad' ? (
        <span
          aria-label="monad"
          role="img"
          style={{
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
          }}
        />
      ) : icon && isProductIconId(icon) ? (
        <ProductIcon
          product={icon}
          size={Math.round(size * 0.72)}
        />
      ) : ProviderLogo ? (
        <ProviderLogo className="size-[58%]" />
      ) : (
        av
      )}
    </div>
  );
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
    icon?: Participant['icon'];
    name: string;
  };
  bare?: boolean;
  bordered?: boolean;
  size?: number;
}): React.ReactElement {
  return (
    <Avatar
      av={agent.av ?? agent.name.slice(0, 2).toUpperCase()}
      avatarUrl={agent.avatarUrl}
      bare={bare}
      bordered={bordered}
      icon={agent.icon}
      kind="agent"
      size={size}
    />
  );
}

export function TagChip({ tag }: { tag: string }): React.ReactElement {
  const isAgent = tag === 'AI' || tag === 'BOT';
  return (
    <span
      style={{
        fontFamily: mono,
        fontSize: 9,
        color: isAgent ? 'var(--foreground)' : 'var(--muted-foreground)',
        border: `1px solid ${isAgent ? 'var(--accent-blue)' : 'var(--border)'}`,
        background: isAgent ? 'var(--accent-blue-soft)' : 'transparent',
        borderRadius: 5,
        padding: '1px 5px'
      }}
    >
      {tag}
    </span>
  );
}

export function MiniTag({ tag }: { tag: string }): React.ReactElement {
  return (
    <span
      style={{
        fontFamily: mono,
        fontSize: 8,
        color: 'var(--foreground)',
        border: `1px solid ${'var(--accent-blue)'}`,
        borderRadius: 4,
        padding: '0 4px'
      }}
    >
      {tag}
    </span>
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
  return (
    <span
      className={className}
      style={{ display: 'inline-flex', alignItems: 'center', minWidth: 0 }}
    >
      <span
        style={{
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          ...nameStyle
        }}
        title={name}
      >
        {name}
      </span>
      {badge ? (
        <span style={{ flex: 'none', marginLeft: badgeGap, display: 'inline-flex', alignItems: 'center' }}>
          {badge}
        </span>
      ) : null}
    </span>
  );
}

export function PresenceDot({ presence, size = 8 }: { presence: Presence; size?: number }): React.ReactElement {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: presenceColor(presence),
        display: 'inline-block',
        flex: 'none'
      }}
    />
  );
}

export function PresenceBadge({ presence }: { presence: Presence }): React.ReactElement {
  return (
    <span
      style={{
        position: 'absolute',
        right: -2,
        bottom: -2,
        width: 10,
        height: 10,
        borderRadius: '50%',
        border: `2px solid ${'var(--muted)'}`,
        background: presenceColor(presence)
      }}
    />
  );
}

export function inkButtonStyle(extra?: CSSProperties): CSSProperties {
  return {
    border: `1px solid ${'var(--accent-blue)'}`,
    borderRadius: boxR,
    background: 'var(--accent-blue)',
    color: 'var(--primary-foreground)',
    fontFamily: sans,
    fontWeight: 600,
    ...extra
  };
}

export function ghostButtonStyle(extra?: CSSProperties): CSSProperties {
  return {
    border: `1px solid ${'var(--border)'}`,
    borderRadius: boxR,
    background: 'var(--card)',
    color: 'var(--foreground)',
    fontFamily: sans,
    fontWeight: 500,
    ...extra
  };
}
