# Workspace Home Polish

## Goal

Make the workspace home feel intentional and memorable without slowing down the primary job: starting a session. The experience should retain the existing two-part mental model, `I want to do...` and `with...`, while making the selected intent and target read as one coherent launch decision.

## Experience Direction

Use a restrained, product-native composition with one earned moment of delight. The page should feel calm while composing, precise while selecting, and decisive when starting.

- Keep the shared `ComposerShell` as the single composer implementation.
- Replace the decorative pointer-following gradient with a quieter ambient field whose emphasis responds to meaningful state: composer focus, target selection, and launch.
- Reduce the oversized heading hierarchy. `I want to do...` remains the primary prompt; `with...` becomes a compact continuation rather than a second hero headline.
- Present agent and project targets as a focused chooser with clear selected, hover, focus, empty, and disabled states.
- Keep the default agent option explicit and immediately available.

## Launch Ritual

The launch feedback must complete in 140–180ms and must not introduce a perceived delay.

1. Submission locks the controls and changes the submit affordance to a brief launching state.
2. The selected target receives a short confirmation emphasis while the surrounding chooser softens.
3. Navigation begins as soon as session creation resolves. Existing-session navigation remains immediate.
4. Reduced-motion mode uses an instant state change with no transform or blur animation.

The ritual is confirmation, not a loading sequence. It must never block navigation after the API result is available.

## Component Boundaries

`WorkspaceHome` remains the flow owner: intent, target mode, selected target, launch status, mutations, and navigation.

Small local presentation components may be extracted when they make states easier to reason about:

- `WorkspaceIntentStep`: prompt and shared composer.
- `WorkspaceTargetPicker`: mode control, target list, empty states, and selection.
- `WorkspaceLaunchSummary`: compact selected-target context close to the submit action.

Do not modify the shared composer API solely for decorative styling. Use an existing wrapper or a narrowly scoped class/style hook if the home needs a distinct surrounding composition.

## Data And Behavior

- Preserve project and agent prefill from `useWorkspaceShellStore`.
- Preserve new default-agent session creation when no existing agent session is selected.
- Preserve navigation to an existing selected agent session without creating a duplicate.
- Preserve project-session creation and project-session routing.
- Add one guarded launch state so repeated submit events cannot create duplicate sessions.
- Surface mutation failures inline near the launch control and restore the editable state.

## Responsive And Accessibility

- Desktop: center the task area, keep the chooser scan-friendly, and avoid using the full viewport as decorative space.
- Mobile: stack all controls, maintain 44px touch targets, and keep the composer and selected target visible without horizontal scrolling.
- Keyboard: tab order follows composer, mode selector, targets, submit; pressed and busy states remain semantic.
- Focus indicators must remain visible; text and placeholders must meet WCAG AA contrast.
- All motion honors `prefers-reduced-motion`.

## Verification

- Verify default agent, existing agent session, and project session paths.
- Verify prefilled project and agent entry points.
- Verify duplicate-submit prevention and mutation error recovery.
- Verify keyboard-only use and reduced motion.
- Capture desktop and mobile screenshots from the running web and API servers.
- Run targeted unit tests, TypeScript, and formatting checks for touched files.

## Out Of Scope

- Changes to session APIs, project APIs, sidebar behavior, or session-page composer behavior.
- A long cinematic transition, autoplay page entrance sequence, new illustration system, or new global color palette.
