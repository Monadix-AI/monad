# Design QA: workspace setup cards

- Source visual truth: `/var/folders/ch/j9tt1f4j3s76jywl7jpz6sz00000gn/T/codex-clipboard-a1133a9b-150f-42a7-aeed-1b8be08bea49.png`
- Implementation screenshot: `/private/tmp/monad-workspace-setup-cards-final-clean.png`
- Responsive screenshot: `/private/tmp/monad-workspace-setup-cards-narrow.png`
- Desktop viewport: 1536 x 700 CSS px at device scale factor 1
- Narrow viewport: 560 x 760 CSS px at device scale factor 1
- Source pixels: 1720 x 476
- Implementation pixels: 1536 x 700
- State: new session with no configured default profile and no enabled Mesh Agent
- Data setup: the browser QA session returned empty profile and Mesh Agent lists for the two read-only settings requests; no persistent configuration was changed

## Full-view comparison

The implementation preserves the existing Monad new-session hierarchy and places the requested cards directly below the composer. The card group uses the reference's white surface, thin neutral border, soft shadow, large radius, top-left colored icon, and bottom-aligned title. The production screen intentionally renders two conditional cards rather than the reference's four example actions.

## Focused region comparison

The card row was compared directly because it contains the fidelity-critical spacing, icon, border, radius, and typography details. The cards align to the composer width, split evenly on desktop, and stack without clipping at the narrow breakpoint.

## Required fidelity surfaces

- Fonts and typography: existing Monad font stack retained; medium-weight titles use a compact line height and match the reference hierarchy.
- Spacing and layout rhythm: 12 px inter-card gap, balanced 20 px horizontal padding, 128 px minimum height, and a 21.6 px radius preserve the reference rhythm inside the existing page grid.
- Colors and visual tokens: card/background/border use Monad semantic tokens; profile and Mesh icons use distinct blue and green semantic colors.
- Image quality and assets: no raster assets are required; both icons come from the existing Hugeicons library.
- Copy and content: concise setup actions describe the two requested missing states and remain readable without supporting copy.

## Interaction and console checks

- Profile card navigated to `/studio/models`.
- Mesh Agent card navigated to `/studio/meshAgents`.
- Desktop and narrow layouts were rendered in the in-app browser.
- Final clean render reported no browser console warnings or errors.

## Findings

No actionable P0, P1, or P2 differences remain. The number and labels of cards differ intentionally because the screenshot is a visual reference while the product requirement defines two conditional setup actions.

## Comparison history

No P0, P1, or P2 iteration was required. A P3 refinement changed the Mesh icon from the same blue as the Profile icon to green, matching the reference's differentiated action colors.

## Follow-up polish

None required for this scope.

final result: passed
