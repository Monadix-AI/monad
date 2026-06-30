import type { CSSProperties } from 'react';

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

export const presenceColor = (p: 'online' | 'working' | 'idle'): string =>
  p === 'online' ? 'var(--success)' : p === 'working' ? 'var(--accent-blue)' : 'var(--muted-foreground)';
