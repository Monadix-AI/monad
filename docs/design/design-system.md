---
title: "Design System"
description: "Monad's web UI uses a layered surface system: dark-first, dense, quiet, and operational. The primary app canvas is rgb(32 33 36) in dark mode, with panels."
---
## Overview

Monad's web UI uses a layered surface system: dark-first, dense, quiet, and operational. The primary app canvas is `rgb(32 33 36)` in dark mode, with panels layered using semi-transparent surface containers instead of heavy shadows or decorative gradients. Light mode exists as the same token system inverted to a pale canvas, not as a separate visual language.

The core rule is token parity. Components should use the raw RGB token names when matching the base primitives (`--backgroundColor-primary`, `--backgroundColor-surface-container`, `--textColor-primary`, `--borderColor-secondary`) and semantic aliases (`--background`, `--card`, `--foreground`, `--border`) when building ordinary app UI. Do not hard-code one-off oklch or hex values for app chrome.

## Colors

### Raw base tokens

These tokens are stored as RGB channel triplets so they can be composed with alpha:

```css
rgb(var(--backgroundColor-primary) / 1)
rgb(var(--backgroundColor-surface-container) / 0.5)
rgb(var(--textColor-primary) / 1)
rgb(var(--borderColor-secondary) / 0.15)
```

### Light

| Token | Value | Use |
|---|---:|---|
| `--backgroundColor-primary` | `250 250 250` | Primary light canvas |
| `--backgroundColor-secondary` | `245 245 245` | Secondary fills |
| `--backgroundColor-surface` | `250 250 250` | Flat surfaces |
| `--backgroundColor-surface-container` | `255 255 255` | Container surface source |
| `--backgroundColor-surface-inverse` | `32 33 36` | Inverse/primary button fill |
| `--backgroundColor-state-enabled` | `245 245 245` | Enabled state layer |
| `--backgroundColor-state-hover` | `238 238 238` | Hover layer |
| `--backgroundColor-state-pressed` | `224 224 224` | Pressed layer |
| `--backgroundColor-state-active` | `232 232 232` | Active state |
| `--backgroundColor-accent` | `96 86 240` | Accent/focus |
| `--textColor-primary` | `32 33 36` | Primary text |
| `--textColor-secondary` | `102 102 102` | Secondary text |
| `--textColor-inverse-primary` | `241 243 244` | Text on inverse surfaces |
| `--textColor-accent` | `96 86 240` | Links/accent text |
| `--borderColor-secondary` | `0 0 0` | Border source, used with low alpha |
| `--outlineColor-focus-ring` | `241 243 244` | Focus ring source |

### Dark

| Token | Value | Use |
|---|---:|---|
| `--backgroundColor-primary` | `32 33 36` | Primary dark canvas |
| `--backgroundColor-secondary` | `22 23 24` | Secondary dark fills |
| `--backgroundColor-surface` | `32 33 36` | Flat surfaces |
| `--backgroundColor-surface-container` | `22 23 24` | Container surface source |
| `--backgroundColor-surface-inverse` | `241 243 244` | Inverse/primary button fill |
| `--backgroundColor-state-enabled` | `56 59 61` | Enabled state layer |
| `--backgroundColor-state-hover` | `110 115 119` | Hover layer |
| `--backgroundColor-state-pressed` | `152 158 164` | Pressed layer |
| `--backgroundColor-state-active` | `60 64 67` | Active state |
| `--backgroundColor-accent` | `113 104 246` | Accent/focus |
| `--textColor-primary` | `241 243 244` | Primary text |
| `--textColor-secondary` | `189 193 198` | Secondary text |
| `--textColor-inverse-primary` | `32 33 36` | Text on inverse surfaces |
| `--textColor-accent` | `113 104 246` | Links/accent text |
| `--borderColor-secondary` | `218 220 224` | Border source, used with low alpha |
| `--outlineColor-focus-ring` | `241 243 244` | Focus ring source |

### Semantic Aliases

`packages/ui/src/styles.css` maps the raw tokens into shadcn/Tailwind-compatible aliases:

| Alias | Definition |
|---|---|
| `--background` | `rgb(var(--backgroundColor-primary))` |
| `--foreground` | `rgb(var(--textColor-primary))` |
| `--card` | `rgb(var(--backgroundColor-surface-container))` |
| `--popover` | `rgb(var(--backgroundColor-surface-container))` |
| `--primary` | `rgb(var(--backgroundColor-surface-inverse))` |
| `--primary-foreground` | `rgb(var(--textColor-inverse-primary))` |
| `--secondary` | `rgb(var(--backgroundColor-secondary))` |
| `--muted` | `rgb(var(--backgroundColor-state-enabled))` |
| `--accent` | `rgb(var(--backgroundColor-state-hover))` |
| `--link` | `rgb(var(--textColor-accent))` |
| `--border` | `rgb(var(--borderColor-secondary) / 0.1)` |
| `--input` | `rgb(var(--borderColor-secondary) / 0.14)` |
| `--ring` | `rgb(var(--outlineColor-focus-ring))` |
| `--sidebar` | `rgb(246 246 246)` light / `rgb(33 33 33)` dark |
| `--destructive` / `--success` / `--warning` / `--info` | fixed status colors, not derived from a raw token |

`--chart-1` … `--chart-5` and the `--sidebar-*` family follow the same pattern; read
`packages/ui/src/styles.css` for the complete list.

The sidebar uses an app-chrome palette independent of content surfaces: foreground is
`rgb(26 28 31)` in light mode and white in dark mode; secondary text is 70% foreground,
selected rows are 5%, and hover states and borders are 8%. Keep brand purple for focus,
links, and semantic status instead of persistent navigation chrome.

## Surfaces

App panels compose the surface-container token over the canvas, with alpha chosen per
surface rather than baked into a single utility class:

```css
background-color: rgb(var(--backgroundColor-surface-container) / 0.5);
```

In dark mode a half-alpha container computes to `rgba(22, 23, 24, 0.5)` over the
`rgb(32, 33, 36)` canvas; in light mode to `rgba(255, 255, 255, 0.5)` over
`rgb(250, 250, 250)`. The `--card`, `--popover`, and `--sidebar` aliases resolve the same
token at full opacity — reach for those first and only drop to a raw alpha composite when
a surface genuinely needs to read through.

Use this layer for cards, sidebars, composer shells, settings panels, and compact dashboard
modules. Use `--backgroundColor-secondary` without alpha for menus and surfaces that must be
fully opaque.

## Typography

Use the existing app font stack:

- `--font-ui`: the platform system stack (`-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, …) for all interface text.
- `--font-code`: the system mono stack (`ui-monospace`, `SF Mono`, `Menlo`, `Consolas`, …) reserved for source code, terminals, commands, diffs, raw logs, and structured data editors.

Headings should stay functional and compact. The product UI should not use oversized marketing hero typography inside app surfaces. Labels, timestamps, counters, IDs, paths, metadata, buttons, and status text all use the UI family.

### App Density Reference

Use these values as the density target for Monad's app chrome and operational screens.

#### Font Families

| Role | Reference value | Monad target |
|---|---|---|
| UI | `var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif)` | Use `--font-ui` for every component and text surface unless the content itself is code |
| Code | `ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace` | Use `--font-code` only for source code, terminals, commands, diffs, raw logs, and structured data editors |

#### Type Scale

The product UI scale is denser than Tailwind defaults:

| Token | Size | Line-height | Use |
|---|---:|---:|---|
| `text-xs` | `11px` | about `16px` | metadata, counters, compact badges, secondary timestamps |
| `text-sm` | `12px` | about `17px` | dense labels, secondary rows, settings descriptions |
| `text-ui` | `14px` | `18px` | control-height UI text |
| `text-base` | `14px` | `18px` | primary sidebar rows, toolbar labels, buttons, list titles |
| `text-lg` | `16px` | `24px` | compact section titles and header labels |
| `text-xl` | `18px` | `24px` | prominent labels |
| `text-heading-sm` | `18px` | `24px` | panel headings only |
| `text-heading-md` | `20px` | `28px` | settings or page section headers |
| `text-heading-lg` | `24px` | `32px` | rare page-level headings |

Practical Monad mapping:

- Sidebar row text: `13px / 18px`, `font-weight: 400`.
- Active/sidebar emphasis: at most `500`; avoid `600` except brand/title.
- Toolbar/header title: `14px / 18px`, `font-weight: 500`.
- Button/control text: `12px / 18px` for small controls, `14px / 18px` for toolbar/composer controls.
- Settings labels/descriptions: `12-14px`, mostly `400`; use `500` only for group titles.
- Do not use `text-xl+` inside app chrome except rare empty states or page headings.

#### Font Weight

| Weight | Use |
|---:|---|
| `400` | Default sidebar rows, descriptions, settings values, menu items |
| `500` | Toolbar labels, active tab labels, settings group titles, important list titles |
| `600` | Brand mark, modal/page title, critical emphasis only |
| `700` | Avoid in routine app UI |

#### Row And Toolbar Density

Reference row/toolbar tokens:

| Token | Value |
|---|---:|
| `--spacing-row-x` | `0.5rem` (`8px`) |
| `--spacing-row-y` | `0.25rem` (`4px`) |
| `--spacing-panel` | `0.75rem` (`12px`) |
| `--spacing-toolbar` | `1rem` (`16px`) |
| `--height-token-nav-row` | `29px` |
| `--height-token-sidebar-row` | `28px` |
| `--height-toolbar` | `46px` |
| `--height-toolbar-sm` | `36px` |
| `--height-toolbar-pane` | `40px` |
| `--leading-control` / `--leading-row` | `18px` / `21px` |

Use these as upper bounds for ordinary chrome. If a sidebar item needs two lines, keep the row at `px-2`/`py-1.5` or `px-3`/`py-2`; do not turn sidebar navigation into card-like rows.
Adjacent sidebar rows use a `1px` gap, producing a `29px` center-to-center rhythm.

#### Buttons And Controls

Reference button variants:

| Variant | Shape | Size / padding | Text |
|---|---|---|---|
| default | `rounded-full` | `px-2 py-0.5` | `12px / 18px` |
| toolbar | `rounded-lg` | `h-token-button-composer px-2 py-0` | `14px / 18px` |
| composer | `rounded-full` | `h-token-button-composer px-2 py-0` | `12px / 18px` |
| composerSm | `rounded-full` | `h-token-button-composer-sm px-1.5 py-0` | `12px / 18px` |
| medium | `rounded-lg` | `px-4 py-1.5` | `14px / 18px` |
| large | `rounded-full` | `px-5 py-2` | `14px / 18px` |
| iconSm | `rounded-md` | `16px x 16px`, `p-0.5` | icon only |

Composer button tokens:

```css
--height-token-button-composer: 28px;
--height-token-button-composer-sm: 28px;
```

In Monad, routine buttons should stay around `28-32px` high. Composer send/stop may be larger, but should remain visually subordinate to the input surface; avoid `56px` controls unless the whole composer is intentionally oversized.

#### Lists, Sidebar, Settings

Extracted recurring component patterns:

| Component | Class pattern | Density implication |
|---|---|---|
| Selectable list row | `min-h-10 px-3 py-3 text-base`, title `14px`, second line `text-sm leading-[22px]` | General content lists can be `40px+`; navigation sidebars should be tighter |
| Local task row | `px-row-x`, `h-9`, labels `text-base/text-sm`, chips `h-5`, icon controls `h-8/h-9` | Use `36px` rows for task/chat rows, `20px` chips |
| Settings row | default `gap-4 p-3`, nested `min-h-10 px-4 py-0.5`, label `text-sm`, description `text-sm` or `text-xs` | Settings can be denser than cards; do not add inner card borders |
| Settings group header | `h-toolbar`, title `text-base font-medium`, subtitle `text-base font-normal` | Group headers align to toolbar height rather than page-title scale |
| Tabs segmented | container `rounded-lg border`, tab `px-4 py-1.5 text-sm font-medium`; toolbar tab `px-2 py-1 gap-1.5` | Tabs are compact controls, not large pills |
| Thread page header | `electron:h-toolbar`, label `text-base electron:font-medium`, secondary `leading-[18px] font-normal` | Header text should be compact and centered in `46px` height |

#### Composer And Thread Layout

| Token / pattern | Value |
|---|---:|
| Composer border radius | `--radius-3xl` = `1.25rem * 1.25` under superellipse support |
| Composer attachment inset | `8px`; attachment bottom padding `6px` |
| Above-composer portal padding | `px-5`, optional `pb-2` |
| Thread content max width | `48rem` |
| Markdown wide block max width | `56rem` |
| Conversation block gap | `12px` |
| Tool/assistant gap | `16px` |
| Thread content top inset | `32px`; floating top/bottom inset `16px` |

#### Shapes, Borders, Shadow

Radii are tight. The `1.25` corner-radius scale is already baked into the token values —
do not re-apply it:

| Token | Value | Pixels |
|---|---:|---:|
| `--radius-2xs` | `0.125rem` | `2px` |
| `--radius-xs` | `0.3125rem` | `5px` |
| `--radius-sm` | `0.46875rem` | `7.5px` |
| `--radius-md` | `0.625rem` | `10px` |
| `--radius-lg` | `0.78125rem` | `12.5px` |
| `--radius-xl` | `0.9375rem` | `15px` |
| `--radius-2xl` | `1.25rem` | `20px` |
| `--radius-3xl` | `1.5625rem` | `25px` |
| `--radius-4xl` | `1.875rem` | `30px` |
| `--radius-pill` | `999px` | fully rounded |

Default app chrome favors hairline borders over elevation:

```css
--shadow-2xs: 0 1px 0 oklch(0 0 0 / 0.04), 0 1px 2px -1px oklch(0 0 0 / 0.06);
--shadow-sm:  0 1px 0 oklch(0 0 0 / 0.04), 0 2px 4px -2px oklch(0 0 0 / 0.06), 0 8px 24px -16px oklch(0 0 0 / 0.12);
--shadow-md:  0 1px 0 oklch(0 0 0 / 0.05), 0 4px 8px -4px oklch(0 0 0 / 0.08), 0 24px 48px -24px oklch(0 0 0 / 0.18);
--shadow-lg:  0 1px 0 oklch(0 0 0 / 0.05), 0 4px 8px -4px oklch(0 0 0 / 0.08), 0 24px 48px -24px oklch(0 0 0 / 0.24);
```

The full ladder runs `--shadow-2xs` through `--shadow-2xl`; each step is a hairline plus a
soft ambient layer, never a hard drop shadow.

Use `shadow-sm/md` only for floating or elevated surfaces. Sidebars, route shells, settings groups, and composer surfaces should primarily use background contrast plus `0.5px-1px` borders.

#### Motion

There are no motion custom properties — durations and easings are written as Tailwind
utilities on the component. The budget:

- Routine controls: `duration-150 ease-out` on color, border, opacity, and shadow only
  (`Button.tsx` is the reference).
- Larger panel/composer state changes: `300ms cubic-bezier(0.4, 0, 0.2, 1)`.
- Never animate layout properties, and honor `prefers-reduced-motion` for anything
  beyond a state fade.

## Shapes

Functional controls use tight radii:

| Token | Use |
|---|---|
| `--radius-md` | Buttons, inputs, compact controls |
| `--radius-lg` | Panels and cards |
| `--radius-3xl` | Composer input shell |
| `--radius-pill` | Avatars, chips, and circular icon buttons only |

Avoid pill-heavy app chrome unless the control is a segmented chip or mode selector.

## Components

### Buttons

Primary buttons use inverse surface fill:

- Background: `--primary`
- Text: `--primary-foreground`
- Hover: slightly reduced opacity or state layer, not a new hue
- Radius: `--radius-md`

Secondary, outline, and ghost buttons should use `--secondary`, `--background`, `--accent`, and `--border`. Avoid shadows and translate-on-hover motion for routine app controls.

### Cards And Panels

Default panels:

- Background: `--card`
- Border: `1px solid var(--border)`
- Radius: `--radius-lg`
- Shadow: none by default

Use visual hierarchy through density, grouping, and border contrast before adding elevation.

### Composer

The composer should feel like a command surface:

- Surface: `rgb(var(--backgroundColor-surface-container) / 0.5)`
- Idle border: `rgb(var(--borderColor-secondary) / 0.15)`
- Focus border: same as idle; focus is shown by the animated aurora ring, not a static accent border
- Focus ring: none on the shell; the aurora layer is the focus treatment
- Focus surface: same tokenized surface, with only the internal aurora glow layer fading in below content
- Placeholder: `--muted-foreground`
- Radius: `--radius-3xl`
- Transition: `300ms cubic-bezier(0.4, 0, 0.2, 1)` for border, background, and ring state

The composer's active border uses these aurora tuning values: `duration: 3.4s`, `borderThickness: 1`, `borderOpacity: 1`, `gradientCoverage: 25`, `tailSoftness: 10`, `innerGlowBlur: 45`, `glowMode: inside`, and the color set `#9154E7`, `#6056F0`, `#40D9C6`, `#4285F4`. On Monad's darker app canvas, the internal glow should be tuned below `innerGlowOpacity: 0.25` / `innerGlowInset: 53` so it reads as a soft edge shimmer rather than a foreground sweep. It should remain a focused composer treatment, honor `prefers-reduced-motion`, and never become a decorative glow around ordinary panels.

Composer nesting must keep animation and content separated:

```tsx
<ChatInputChrome className="shared-composer-panel">
  <div className="chat-input-frame">
    <div className="chat-input-aurora" aria-hidden="true">
      <div className="chat-input-aurora-root">
        <div className="chat-input-aurora-inner-glow">{/* edge-masked glow */}</div>
        <div className="chat-input-aurora-border-pulse">{/* content-box masked ring */}</div>
      </div>
    </div>
    <div className="chat-input-surface" role="presentation">
      <div className="chat-input-content">{/* editor / mention layer */}</div>
      <div className="shared-composer-toolbar">{/* controls */}</div>
    </div>
  </div>
</ChatInputChrome>
```

`chat-input-frame` only owns relative positioning. `chat-input-aurora` is the absolute pointer-events-none overlay sibling above the real surface (`relative w-full` containing an absolute `z-[50]` aurora layer plus a `role="presentation"` surface). The overlay must be internally constrained: inner glow uses four edge masks (`top`, `bottom`, `left`, `right`) and the border ring uses a `content-box` mask with `padding: 1px`. The rotating conic-gradient child is `150vmax`, centered at `top: 50%` / `left: 50%`, and animated with `translate(-50%, -50%) rotate(...)`; do not rotate the overlay box itself. Do not add a static focus border-color or shell box-shadow that competes with the animated ring.

## Layout

The homepage is a workspace overview and must not show the session sidebar on first entry. App views after selecting a session or channel may use the sidebar. Dense operational panels are preferred over marketing layout patterns.

Use full-width app bands and constrained inner content rather than card-in-card compositions. Cards are for individual repeated items, modals, settings groups, and framed tools.

## Motion

Motion should clarify state changes only:

- Use 150-200ms transitions for color, border, opacity, and box-shadow.
- Avoid translate-on-hover for routine controls.
- Honor `prefers-reduced-motion`.
- Do not animate layout properties.

## Do

- Use `--backgroundColor-primary` and related raw RGB tokens when implementing base primitive controls.
- Keep dark mode anchored to `rgb(32 33 36)`.
- Build surface hierarchy with `rgb(var(--backgroundColor-surface-container) / 0.5)`.
- Keep borders low-alpha and crisp.
- Use accent purple only for links, focus, and small state cues.

## Don't

- Do not reintroduce a near-white marketing palette as the primary app system.
- Do not hard-code new hex/oklch app chrome colors when a token exists.
- Do not put sidebars on the root workspace homepage.
- Do not use heavy shadows, glow effects, or decorative gradient backgrounds for ordinary app panels.
