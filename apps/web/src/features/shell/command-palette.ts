import { matchesKeyboardEvent } from '@tanstack/hotkeys';

export const commandPaletteHotkey = 'Mod+K' as const;

interface CommandPaletteItem {
  id: string;
  keywords?: string[];
  label: string;
  shortcut?: string;
  subtitle?: string;
  run: () => void;
}

export interface CommandPaletteSection {
  heading: 'Quick actions' | 'Recents';
  items: CommandPaletteItem[];
}

interface BuildCommandPaletteSectionsArgs {
  actions: CommandPaletteItem[];
  recents: CommandPaletteItem[];
}

export function matchesCommandPaletteHotkey(event: KeyboardEvent, applePlatform: boolean): boolean {
  return matchesKeyboardEvent(event, commandPaletteHotkey, applePlatform ? 'mac' : 'windows');
}

export function buildCommandPaletteSections({
  actions,
  recents
}: BuildCommandPaletteSectionsArgs): CommandPaletteSection[] {
  const sections: CommandPaletteSection[] = [
    { heading: 'Quick actions', items: actions },
    { heading: 'Recents', items: recents }
  ];
  return sections.filter((section) => section.items.length > 0);
}

export function commandPaletteSearch(sections: CommandPaletteSection[], query: string): CommandPaletteSection[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return sections;

  return sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => commandPaletteItemSearchText(item).includes(normalizedQuery))
    }))
    .filter((section) => section.items.length > 0);
}

export function highlightedCommandPaletteParts(label: string, query: string): Array<{ match: boolean; text: string }> {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [{ match: false, text: label }];

  const matchIndex = normalizeSearchText(label).indexOf(normalizedQuery);
  if (matchIndex < 0) return [{ match: false, text: label }];

  const matchEnd = matchIndex + normalizedQuery.length;
  return [
    { match: false, text: label.slice(0, matchIndex) },
    { match: true, text: label.slice(matchIndex, matchEnd) },
    { match: false, text: label.slice(matchEnd) }
  ].filter((part) => part.text.length > 0);
}

function commandPaletteItemSearchText(item: CommandPaletteItem): string {
  return normalizeSearchText([item.label, item.subtitle, ...(item.keywords ?? [])].filter(Boolean).join(' '));
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase();
}
