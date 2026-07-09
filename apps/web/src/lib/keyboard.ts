export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return true;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = (nav.userAgentData?.platform ?? nav.platform).toLowerCase();
  return /mac|iphone|ipad|ipod/.test(platform);
}

export function primaryModifierPressed(event: KeyboardEvent, applePlatform: boolean): boolean {
  return applePlatform ? event.metaKey : event.ctrlKey;
}

export function shortcutNumberFromEvent(event: KeyboardEvent): number | null {
  const keyNumber = Number.parseInt(event.key, 10);
  if (Number.isInteger(keyNumber) && keyNumber >= 1 && keyNumber <= 9) return keyNumber;

  const codeMatch = /^(?:Digit|Numpad)([1-9])$/.exec(event.code);
  return codeMatch ? Number.parseInt(codeMatch[1] ?? '', 10) : null;
}
