export type ThemePreference = 'auto' | 'dark' | 'light';

const THEME_STORAGE_KEY = 'monad:theme';

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => { ready: Promise<void> };
};

export function getThemePreference(): ThemePreference {
  if (typeof localStorage === 'undefined') return 'auto';
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  return stored === 'dark' || stored === 'light' || stored === 'auto' ? stored : 'auto';
}

export function resolveThemePreference(preference: ThemePreference): boolean {
  if (preference === 'dark') return true;
  if (preference === 'light') return false;
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function applyThemePreference(preference: ThemePreference): boolean {
  const dark = resolveThemePreference(preference);
  document.documentElement.classList.toggle('dark', dark);
  if (typeof localStorage !== 'undefined') localStorage.setItem(THEME_STORAGE_KEY, preference);
  return dark;
}

export async function transitionThemePreference(
  preference: ThemePreference,
  source?: Element | null
): Promise<boolean> {
  const nextDark = resolveThemePreference(preference);
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const viewTransitionDocument = document as ViewTransitionDocument;
  if (!viewTransitionDocument.startViewTransition || reduceMotion) return applyThemePreference(preference);

  const transition = viewTransitionDocument.startViewTransition(() => {
    applyThemePreference(preference);
  });

  await transition.ready;
  const rect = source?.getBoundingClientRect();
  const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
  const y = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
  const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  document.documentElement.animate(
    {
      clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`]
    },
    {
      duration: 520,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      pseudoElement: '::view-transition-new(root)'
    } as KeyframeAnimationOptions
  );
  return nextDark;
}
