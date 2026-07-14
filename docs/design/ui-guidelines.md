# UI design guidelines

Rules for building visual surfaces in `apps/web` and `@monad/ui`. The design token
catalogue — colors, surfaces, typography, spacing, radii, motion values, and component
specs — lives in [design-system.md](design-system.md); treat that file as the single
source of truth for tokens and this file as the rules for applying them. Interaction and
state conventions are in [ux-guidelines.md](ux-guidelines.md); all user-facing copy
follows [ux-writing-guidelines.md](ux-writing-guidelines.md).

## Tokens and theming

- **Use tokens, never one-off values.** Components use the raw RGB tokens
  (`--backgroundColor-primary`, `--textColor-primary`, `--borderColor-secondary`, …)
  when matching Stitch primitives, and the semantic aliases (`--background`, `--card`,
  `--foreground`, `--border`, …) for ordinary app UI. Do not hard-code hex or oklch
  values for app chrome when a token exists.
- **Dark-first, with light parity.** The primary canvas is dark (`rgb(32 33 36)`);
  light mode is the same token system inverted to a pale canvas, not a separate visual
  language. Every token has a value in both themes, so a component styled entirely
  through tokens is automatically correct in both. Never style one theme with tokens
  and patch the other with literals.
- **Surface hierarchy through alpha layers, not shadows.** Panels, cards, sidebars, and
  the composer use the semi-transparent surface-container layer over the canvas;
  opaque `--backgroundColor-secondary` is reserved for menus and popovers. Borders stay
  low-alpha and crisp; `shadow-sm/md` only for genuinely floating surfaces.
- **Accent is a state color, not a brand wash.** Accent purple appears only on links,
  focus, and small state cues — never as panel backgrounds or decorative gradients.

## Components (`@monad/ui`)

`@monad/ui` is the headless shared component library: Radix primitives, Tailwind, and
CVA, presentation only.

- **One file per component**, named in PascalCase after the component
  (`Button.tsx`, `DropdownMenu.tsx`).
- **Merge classes with `cn()`.** Never concatenate class strings by hand; `cn()` is the
  single merge point so consumer overrides resolve predictably.
- **Variants live in CVA definitions**, not ad-hoc conditional strings. A new visual
  variant is a new CVA entry with a name, so it is discoverable and reusable.
- **Build on Radix primitives** for anything with keyboard, focus, or ARIA semantics
  (dialogs, menus, popovers, tabs, tooltips) rather than reimplementing the behavior.
- **No data-layer imports.** `@monad/ui` must not import protocol, home, client, or
  daemon packages. Components take data as props.
- **App-specific composition belongs in `apps/web`**, under its components/features
  directories. Promote a pattern into `@monad/ui` only when a second surface needs it.
- **Prefer the existing primitive.** Before writing a new component, check whether an
  `@monad/ui` component (or a variant of one) already covers the case; one-off lookalike
  components are how token drift starts.

## Icons

- Import `HugeiconsIcon` plus named icons from `@hugeicons/core-free-icons`; never
  barrel-import the whole icon set (bundle-size budget, see
  [performance-guidelines.md](../engineering/performance-guidelines.md)).
- Icon-only buttons need an accessible name and normally a tooltip carrying the same
  action text — see the accessibility rules in
  [ux-writing-guidelines.md](ux-writing-guidelines.md).

## Accessibility

WCAG 2.1 AA is the minimum. The copy side (accessible names, alt text, live status
text) is specified in [ux-writing-guidelines.md](ux-writing-guidelines.md); this is the
interaction and visual side:

- **Contrast.** 4.5:1 for body text, 3:1 for large/bold text and essential UI
  boundaries. Token pairs from `design-system.md` meet this; verify contrast whenever
  you compose tokens with alpha over a new surface.
- **Visible focus.** Every focusable element shows a visible focus state, using the
  shared focus-ring token treatment. Never remove an outline without replacing it. The
  composer's aurora ring is a deliberate exception scoped to that one surface — do not
  generalize it.
- **Keyboard reachability.** Everything clickable is focusable and operable by
  keyboard, in a sensible tab order. Radix primitives provide this for free — another
  reason not to hand-roll overlays and menus.
- **ARIA where semantics aren't native.** Prefer native elements and Radix semantics;
  add explicit `aria-*` attributes for icon-only controls, decorative layers
  (`aria-hidden`, as the composer aurora does), and state not conveyed by the DOM.
- **Reduced motion.** Honor `prefers-reduced-motion` for any non-trivial animation,
  including the composer aurora.
- **Don't encode state in color alone.** Pair color with a label, icon, or text state
  name.

## Motion

Motion clarifies state changes; it is never decoration.

- 150-200ms transitions for color, border, opacity, and shadow on routine controls;
  300ms only for larger panel or composer state changes.
- No translate-on-hover for routine controls; do not animate layout properties.
- Exact easing and duration tokens are in [design-system.md](design-system.md).

## Review checklist

Before merging a UI change, verify:

- [ ] All colors, spacing, radii, and shadows come from `design-system.md` tokens; no
      new hard-coded chrome values.
- [ ] The surface renders correctly in both dark and light mode without theme-specific
      literals.
- [ ] New variants are CVA definitions; classes merge through `cn()`.
- [ ] Shared presentation lives in `@monad/ui` (no data-layer imports); app-specific
      composition stays in `apps/web`.
- [ ] Text contrast meets AA on the actual composited surface.
- [ ] Every interactive element is keyboard reachable with a visible focus state.
- [ ] Icon-only controls have accessible names; decorative layers are `aria-hidden`.
- [ ] Icons are named imports, not barrel imports.
- [ ] Animations respect `prefers-reduced-motion` and stay within the motion budget.
- [ ] Hover-revealed controls have a touch fallback and copy follows
      [ux-writing-guidelines.md](ux-writing-guidelines.md) — see
      [ux-guidelines.md](ux-guidelines.md).
