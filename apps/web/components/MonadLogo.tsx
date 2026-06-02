import type { CSSProperties } from 'react';

import { cn } from '@monad/ui';

interface MonadLogoProps {
  className?: string;
}

const logoStyle: CSSProperties = {
  WebkitMaskImage: 'url("/monad-logo.webp")',
  maskImage: 'url("/monad-logo.webp")',
  WebkitMaskRepeat: 'no-repeat',
  maskRepeat: 'no-repeat',
  WebkitMaskPosition: 'center',
  maskPosition: 'center',
  WebkitMaskSize: 'contain',
  maskSize: 'contain'
};

const iconStyle: CSSProperties = {
  WebkitMaskImage: 'url("/monad-icon.webp")',
  maskImage: 'url("/monad-icon.webp")',
  WebkitMaskRepeat: 'no-repeat',
  maskRepeat: 'no-repeat',
  WebkitMaskPosition: 'center',
  maskPosition: 'center',
  WebkitMaskSize: 'contain',
  maskSize: 'contain'
};

export function MonadLogo({ className }: MonadLogoProps) {
  return (
    <span
      aria-label="monad"
      className={cn('block shrink-0 bg-current', className)}
      role="img"
      style={logoStyle}
    />
  );
}

export function MonadIcon({ className }: MonadLogoProps) {
  return (
    <span
      aria-label="monad"
      className={cn('block shrink-0 bg-current', className)}
      role="img"
      style={iconStyle}
    />
  );
}
