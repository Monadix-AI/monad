import type { BundledTheme } from 'shiki';

export const SHIKI_THEME_NAMES = ['github-light', 'github-dark'] satisfies BundledTheme[];

export const SHIKI_THEMES = {
  dark: 'github-dark',
  light: 'github-light'
} as const satisfies Record<'dark' | 'light', BundledTheme>;
