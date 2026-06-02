import type { CSSProperties } from 'react';
import type { ParticipantKind, Presence } from './types';

import { providerLogo } from '@/lib/ProviderMeta';
import { boxR, mono, presenceColor, sans } from './styles';

export function Avatar({
  av,
  icon,
  kind,
  size = 34
}: {
  av: string;
  icon?: 'monad' | 'openai' | 'anthropic';
  kind: ParticipantKind;
  size?: number;
}): React.ReactElement {
  const agent = kind === 'agent';
  const ProductLogo = icon && icon !== 'monad' ? providerLogo(icon).logo : null;
  const style: CSSProperties = {
    flex: 'none',
    width: size,
    height: size,
    border: `1.5px solid ${agent ? 'var(--accent-blue)' : 'var(--border)'}`,
    borderRadius: agent ? Math.round(size * 0.23) : '50%',
    background: agent ? 'var(--accent-blue-soft)' : 'var(--secondary)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: mono,
    fontSize: Math.max(9, Math.round(size * 0.33))
  };
  return (
    <div style={style}>
      {icon === 'monad' ? (
        <span
          aria-label="monad"
          role="img"
          style={{
            width: Math.round(size * 0.58),
            height: Math.round(size * 0.58),
            WebkitMaskImage: 'url("/monad-icon.webp")',
            maskImage: 'url("/monad-icon.webp")',
            WebkitMaskRepeat: 'no-repeat',
            maskRepeat: 'no-repeat',
            WebkitMaskPosition: 'center',
            maskPosition: 'center',
            WebkitMaskSize: 'contain',
            maskSize: 'contain',
            background: 'currentColor'
          }}
        />
      ) : ProductLogo ? (
        <ProductLogo className="size-[58%]" />
      ) : (
        av
      )}
    </div>
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
    cursor: 'pointer',
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
    cursor: 'pointer',
    fontFamily: sans,
    fontWeight: 500,
    ...extra
  };
}
