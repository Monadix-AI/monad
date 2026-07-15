import type { ReactNode } from 'react';
import type { CommandPaletteSection } from './command-palette';

import { cn } from '@monad/ui';
import { Command } from 'cmdk';
import { useMemo, useState } from 'react';

import { commandPaletteSearch, highlightedCommandPaletteParts } from './command-palette';

interface CommandPaletteProps {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  sections: CommandPaletteSection[];
  shortcutModifierLabel: string;
}

export function CommandPaletteDialog({ onOpenChange, open, sections, shortcutModifierLabel }: CommandPaletteProps) {
  const [search, setSearch] = useState('');
  const visibleSections = useMemo(() => commandPaletteSearch(sections, search), [sections, search]);

  return (
    <Command.Dialog
      className="command-palette-dialog fixed top-[10vh] left-1/2 z-[80] w-[min(640px,calc(100vw-28px))] -translate-x-1/2 overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-2xl"
      label="Command palette"
      onOpenChange={onOpenChange}
      open={open}
      shouldFilter={false}
    >
      <div className="border-border/70 border-b bg-muted/20 px-3.5 pt-3 pb-3">
        <div className="mb-2.5 flex items-center justify-between gap-3 px-0.5">
          <span className="font-medium text-muted-foreground text-xs">Command menu</span>
          <ShortcutChip>{shortcutModifierLabel} K</ShortcutChip>
        </div>
        <div className="rounded-lg bg-background px-3 shadow-[inset_0_0_0_1px_var(--input)] transition-shadow duration-150 focus-within:shadow-[inset_0_0_0_1px_rgb(var(--backgroundColor-accent)/0.48),0_0_0_2px_rgb(var(--backgroundColor-accent)/0.08)]">
          <Command.Input
            className="h-10 w-full bg-transparent text-[15px] leading-none outline-none placeholder:text-muted-foreground"
            onValueChange={setSearch}
            placeholder="Search actions and recent sessions…"
            value={search}
          />
        </div>
      </div>
      <Command.List className="max-h-[min(480px,58vh)] overflow-y-auto p-2">
        <Command.Empty className="px-3 py-10 text-center text-muted-foreground text-sm">No results</Command.Empty>
        {visibleSections.map((section) => (
          <Command.Group
            className="command-palette-group"
            heading={section.heading}
            key={section.heading}
          >
            {section.items.map((item) => (
              <Command.Item
                className={cn(
                  'group flex h-10 cursor-default items-center justify-between gap-3 rounded-lg px-3 text-sm outline-none',
                  'data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[selected=true]:shadow-[inset_0_0_0_1px_var(--input)]'
                )}
                key={item.id}
                keywords={item.keywords}
                onSelect={() => {
                  onOpenChange(false);
                  item.run();
                }}
                value={item.id}
              >
                <span className="min-w-0 truncate font-medium">
                  <HighlightedCommandPaletteLabel
                    label={item.label}
                    query={search}
                  />
                </span>
                {item.shortcut ? <ShortcutChip>{item.shortcut}</ShortcutChip> : null}
              </Command.Item>
            ))}
          </Command.Group>
        ))}
      </Command.List>
      <div className="flex flex-wrap items-center gap-1.5 border-border/70 border-t bg-muted/15 px-3.5 py-2 text-muted-foreground text-xs">
        <ShortcutChip>↑↓</ShortcutChip>
        <span>Navigate</span>
        <span className="mx-1 text-border">/</span>
        <ShortcutChip>Enter</ShortcutChip>
        <span>Open</span>
        <span className="mx-1 text-border">/</span>
        <ShortcutChip>Esc</ShortcutChip>
        <span>Close</span>
      </div>
    </Command.Dialog>
  );
}

function ShortcutChip({ children }: { children: ReactNode }) {
  return (
    <kbd
      className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 font-medium text-[11px] text-muted-foreground shadow-[inset_0_0_0_1px_var(--input)]"
      translate="no"
    >
      {children}
    </kbd>
  );
}

function HighlightedCommandPaletteLabel({ label, query }: { label: string; query: string }) {
  let offset = 0;
  return highlightedCommandPaletteParts(label, query).map((part) => {
    const key = `${part.match ? 'match' : 'text'}-${offset}`;
    offset += part.text.length;
    return (
      <span
        className={part.match ? 'rounded bg-primary/15 text-primary' : undefined}
        key={key}
      >
        {part.text}
      </span>
    );
  });
}
