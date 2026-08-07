import type { ChannelIcon } from '@monad/protocol';

import { BrandGlyph } from '@monad/ui/components/BrandGlyph';

/** Renders a channel's brand mark. Thin adapter so app code keeps passing the protocol icon type
 *  while the SVG rendering lives in the presentation package, shared with the chat-room atom. */
export function BrandIcon({ className, icon }: { className?: string; icon: ChannelIcon }) {
  return (
    <BrandGlyph
      className={className}
      icon={icon}
    />
  );
}
