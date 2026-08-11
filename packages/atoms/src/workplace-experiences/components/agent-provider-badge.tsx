import type { ChannelIcon } from '@monad/protocol';

import { BrandGlyph } from '@monad/ui/components/BrandGlyph';

export function AgentProviderBadge({ className = 'size-3.5', icon }: { className?: string; icon?: ChannelIcon }) {
  return icon ? (
    <span
      aria-label={icon.title}
      className={className}
      role="img"
      title={icon.title}
    >
      <BrandGlyph
        className="size-full"
        icon={icon}
      />
    </span>
  ) : null;
}
