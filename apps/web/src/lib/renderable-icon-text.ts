const HUGEICONS_SYMBOL_NAME_RE = /^[A-Z][A-Za-z0-9]*Icon$/;

export function renderableIconText(icon: string | undefined): string | undefined {
  if (!icon) return undefined;
  const value = icon.trim();
  if (!value || HUGEICONS_SYMBOL_NAME_RE.test(value)) return undefined;
  return value;
}
