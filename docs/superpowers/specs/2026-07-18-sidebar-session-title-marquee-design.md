# Sidebar Session Title Marquee Design

## Goal

Make long sidebar session titles readable without ellipses or permanent space reserved for row actions. The row should preserve a quiet default state, reveal actions on intent, and let a pointer user read the complete title without opening a tooltip.

## Scope

This behavior applies only to `WorkspaceTreeItem` instances marked with `sidebarSession`. That covers ordinary chat sessions, project sessions, and pinned sessions. Project rows, navigation rows, archived items, and other truncated sidebar labels remain unchanged.

Renaming remains an explicit editing state and does not run the marquee. Touch and coarse-pointer layouts keep their current visible-action behavior and do not depend on hover animation.

## Interaction

### Resting state

- Render the title as one unbroken line at its intrinsic width. Do not apply `text-overflow: ellipsis`.
- Clip the title in a dedicated viewport.
- Apply a 20 px right-edge alpha mask so clipped text fades away instead of ending abruptly.
- Keep the full title in the row's existing `title` attribute as a fallback.
- Render row actions outside normal flow so they do not reduce the title viewport width.

### Hover state

- Reveal pin, more-menu, and other session-row actions immediately in an absolute right-edge overlay.
- Expand the title's masked area to account for the overlay's measured width. Text may continue beneath the overlay structurally, but must not remain legible behind its controls.
- Start a 600 ms intent delay whenever the pointer enters the row.
- After the delay, animate only if the title's intrinsic width exceeds the currently readable width.
- Move left at 40 px per second and stop when the title's final glyph is visible immediately before the action overlay. Do not loop and do not bounce.
- Add a left-edge fade while the title is displaced so characters exit smoothly, matching the supplied reference states.

### Exit and interruption

- On pointer leave, cancel a pending delay and return to the starting position immediately.
- Opening an action menu, starting rename, changing the title, resizing the row, or unmounting the item cancels the current motion and recomputes geometry before the next hover.
- A title that fits before the actions appear but overflows the readable hover width should animate after the same delay.
- With `prefers-reduced-motion: reduce`, keep clipping, masks, action overlay, and the native title fallback, but do not translate the title.

## Visual and Layout Model

Use a CSS mask on the title viewport rather than a background-colored gradient element. A mask works across the normal, hover, selected, and selected-hover row surfaces without duplicating their color tokens.

The action overlay is a sibling of the row link/button and is positioned against the existing relative row container. It remains above the title viewport for pointer interaction. The link/button continues to occupy the complete row width, so moving actions out of flex flow cannot shrink its label.

The title viewport exposes stable data attributes for behavior tests and uses CSS custom properties for the measured translation distance and animation duration. The moving title uses `transform: translate3d(...)`, avoiding layout work during animation.

## Component Boundaries

Introduce a focused session-title viewport component alongside `WorkspaceTreeItem`. It owns:

- references to the viewport and intrinsic-width title;
- overflow and action-occlusion measurements;
- hover-delay and motion state;
- resize observation and cleanup;
- mask and transform variables.

Keep row navigation, context menus, rename state, and menu action resolution in `WorkspaceTreeItem`. The row supplies the session title and the measured action-overlay element; non-session children continue through the existing rendering path.

Keep the geometry calculation in a small pure helper. Given title width, viewport width, and action-overlay width, it returns whether motion is needed, the terminal translation distance, and the duration required at 40 px per second. Clamp all distances to zero to avoid subpixel reverse motion.

## State Model

The title has four visual states:

1. `idle`: zero translation and right-edge fade.
2. `intent`: actions visible, geometry updated, and the 600 ms timer pending.
3. `moving`: left and right fades active while a linear transform runs.
4. `settled`: terminal transform retained with the final glyph visible.

Pointer exit and all interruptions return directly to `idle`. Reduced-motion users remain in `idle` while actions may still reveal normally.

## Accessibility

- Do not duplicate the readable title in the accessibility tree; the moving span remains the existing visible label.
- Preserve keyboard focus, row naming, `aria-current`, context-menu behavior, and rename input semantics.
- Do not start motion from keyboard focus alone.
- Keep action buttons independently focusable and above the row link/button in stacking order.
- Respect the operating system's reduced-motion preference.

## Verification

Automated tests should establish:

- a fitting title remains stationary after the delay;
- an overflowing title remains stationary before 600 ms;
- after 600 ms, an overflowing title moves by the computed distance at a duration derived from 40 px per second;
- action width contributes to readable-width calculations without reducing the underlying row link/button width;
- pointer exit, rename, resize, and title changes reset or recompute motion;
- reduced-motion mode never translates the title;
- ordinary non-session tree items retain existing truncation and layout behavior.

The sidebar interaction test should also verify that the menu and pin controls remain clickable while overlaid. Runtime visual verification should cover normal, hover-moving, settled, active, and narrow-sidebar states in both light and dark themes.

## Reference-Informed Decisions

The design combines established patterns rather than copying one product wholesale:

- Notion-style sidebar actions validate revealing row controls on hover without permanently emphasizing them.
- Android's native marquee and horizontal fading-edge behavior validate delayed, overflow-aware movement.
- CSS mask-based marquee examples validate background-independent edge fades.
- Media-player marquees validate long-title movement, but their common infinite-loop behavior is intentionally rejected for a navigation list.

## Non-goals

- Infinite or repeated marquee loops.
- Automatic movement without pointer intent.
- Multi-line titles, title wrapping, or dynamic font scaling.
- Changing session naming, sorting, persistence, or rename behavior.
- Applying the pattern to every truncated label in the sidebar.
