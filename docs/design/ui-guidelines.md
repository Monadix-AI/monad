# UI design guidelines

The visual design system for `apps/web` and other rendered surfaces — the design token
catalogue (colors, spacing, typography), the Stitch-derived surface system, theming and
dark-mode rules, and component conventions — lives in the root
[`design-system.md`](design-system.md). Treat that file as the source of truth: use the raw RGB
token names and semantic aliases it defines, and never hard-code one-off hex or oklch
values for app chrome.

This document collects UI-review criteria that build on those tokens.

## Review criteria

- **Token parity.** Components use the tokens in `design-system.md`, not ad-hoc colors, spacing,
  or shadows.
- **Theming.** Every surface is styled for both light and dark mode through the shared
  token system, not a separate visual language per theme.
- **Accessibility.** Meet WCAG 2.1 AA: sufficient contrast, keyboard reachability, and the
  required ARIA patterns for interactive components.
- **Component reuse.** Prefer the shared `@monad/ui` primitives and approved patterns over
  new one-off components.

For interaction, copy, and state (loading/empty/error) conventions, see
[ux-guidelines.md](ux-guidelines.md) and [ux-writing-guidelines.md](ux-writing-guidelines.md).
