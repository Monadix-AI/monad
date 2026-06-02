import type { CommandPaletteSection } from './command-palette';

import { HugeiconsIcon } from '@hugeicons/react';
import { cn, Dialog, DialogContent, DialogTitle, ShortcutChip } from '@monad/ui';
import { Command } from 'cmdk';
import { useMemo } from 'react';

import { commandPaletteSearch, highlightedCommandPaletteParts } from './command-palette';

const commandPaletteSurfaceStyle = { backdropFilter: 'none' };

interface CommandPaletteProps {
  onOpenChange: (open: boolean) => void;
  onSearchChange: (query: string) => void;
  open: boolean;
  search: string;
  sections: CommandPaletteSection[];
}

export function CommandPaletteDialog({ onOpenChange, onSearchChange, open, search, sections }: CommandPaletteProps) {
  const visibleSections = useMemo(() => commandPaletteSearch(sections, search), [sections, search]);

  return (
    <Dialog
      modal
      onOpenChange={onOpenChange}
      open={open}
    >
      <DialogContent
        className="command-palette-dialog top-[10vh] z-[80] block w-[min(560px,calc(100vw-28px))] max-w-none translate-y-0 gap-0 overflow-hidden rounded-xl bg-popover p-0 text-popover-foreground shadow-2xl sm:max-w-none"
        overlayClassName="command-palette-overlay z-[70] bg-black/20 dark:bg-black/45"
        overlayStyle={commandPaletteSurfaceStyle}
        showCloseButton={false}
        style={commandPaletteSurfaceStyle}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <Command
          label="Command palette"
          shouldFilter={false}
        >
          <Command.Input
            className="h-12 w-full border-0 bg-transparent px-4 text-[15px] leading-none shadow-none outline-none placeholder:text-muted-foreground"
            onValueChange={onSearchChange}
            placeholder="Search actions and recent sessions…"
            value={search}
          />
          <Command.List className="max-h-[min(480px,58vh)] overflow-y-auto p-2">
            <Command.Empty className="px-3 py-10 text-center text-muted-foreground text-sm">No results</Command.Empty>
            {visibleSections.map((section) => (
              <Command.Group
                className="command-palette-group mt-2 first:mt-0"
                heading={section.heading}
                key={section.heading}
              >
                {section.items.map((item) => (
                  <Command.Item
                    className={cn(
                      'group flex min-h-8 cursor-default items-center justify-between gap-3 rounded-(--radius-md) px-2 py-1.5 text-sm outline-none',
                      'data-[selected=true]:bg-sidebar-selected data-[selected=true]:hover:bg-sidebar-selected-hover'
                    )}
                    key={item.id}
                    keywords={item.keywords}
                    onSelect={() => {
                      onOpenChange(false);
                      item.run();
                    }}
                    value={item.id}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {item.icon ? (
                        <HugeiconsIcon
                          className="size-4 shrink-0 text-muted-foreground"
                          icon={item.icon}
                        />
                      ) : null}
                      <span className="min-w-0 truncate font-medium">
                        <HighlightedCommandPaletteLabel
                          label={item.label}
                          query={search}
                        />
                      </span>
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
        </Command>
      </DialogContent>
    </Dialog>
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
