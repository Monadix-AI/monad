import type { CSSProperties } from 'react';
import type { Presence } from './types';

export const sans = 'var(--font-sans), ui-sans-serif, system-ui, sans-serif';
export const mono = 'var(--font-mono), ui-monospace, monospace';

export const boxR = '12px';
export const softShadow = 'var(--shadow-lg)';

export const sectionLabel: CSSProperties = {
  fontFamily: mono,
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: 1.2,
  color: 'var(--muted-foreground)',
  textTransform: 'uppercase'
};

export const presenceColor = (p: Presence): string => {
  if (p === 'online') return 'var(--success)';
  if (p === 'working') return 'var(--accent-blue)';
  if (p === 'needs-login') return 'var(--warning, #f59e0b)';
  if (p === 'failed') return 'var(--destructive)';
  if (p === 'stopped') return 'var(--muted-foreground)';
  return 'var(--muted-foreground)';
};
