'use client';

import type { CSSProperties } from 'react';

import { cn } from '@monad/ui';

interface MonadLoadingProps {
  className?: string;
  markClassName?: string;
}

const iconMaskStyle: CSSProperties = {
  WebkitMaskImage: 'url("/monad-icon.webp")',
  maskImage: 'url("/monad-icon.webp")',
  WebkitMaskRepeat: 'no-repeat',
  maskRepeat: 'no-repeat',
  WebkitMaskPosition: 'center',
  maskPosition: 'center',
  WebkitMaskSize: 'contain',
  maskSize: 'contain'
};

export function MonadLoading({ className, markClassName }: MonadLoadingProps) {
  return (
    <div
      aria-label="Loading"
      className={cn('monad-loading flex items-center justify-center', className)}
      role="status"
    >
      <div
        aria-hidden="true"
        className={cn('monad-loading-mark', markClassName)}
        style={iconMaskStyle}
      >
        <span className="monad-loading-glass" />
        <span className="monad-loading-sheen" />
      </div>
    </div>
  );
}
