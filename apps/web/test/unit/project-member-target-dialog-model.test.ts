import { expect, test } from 'bun:test';

import {
  initialProjectMemberTargetDialogState,
  projectMemberTargetDialogTransition
} from '../../src/features/workplace/project-shell/project-member-target-dialog-model';

test('opens a provider with no preselected target', () => {
  expect(
    projectMemberTargetDialogTransition(initialProjectMemberTargetDialogState, {
      type: 'open',
      groupId: 'monad'
    })
  ).toEqual({
    state: { openGroupId: 'monad', selectedCandidateId: null },
    effect: null
  });
});

test('selects only enabled targets without adding them', () => {
  const openState = { openGroupId: 'monad', selectedCandidateId: null };

  expect(
    projectMemberTargetDialogTransition(openState, {
      type: 'select',
      candidateId: 'monad:agt_review000000',
      enabled: true
    })
  ).toEqual({
    state: { openGroupId: 'monad', selectedCandidateId: 'monad:agt_review000000' },
    effect: null
  });
  expect(
    projectMemberTargetDialogTransition(openState, {
      type: 'select',
      candidateId: 'monad:agt_writer000000',
      enabled: false
    })
  ).toEqual({ state: openState, effect: null });
});

test('confirms exactly the selected target and closes the dialog', () => {
  expect(
    projectMemberTargetDialogTransition(
      { openGroupId: 'monad', selectedCandidateId: 'monad:agt_review000000' },
      { type: 'confirm' }
    )
  ).toEqual({
    state: initialProjectMemberTargetDialogState,
    effect: { type: 'add', candidateId: 'monad:agt_review000000' }
  });
  expect(
    projectMemberTargetDialogTransition({ openGroupId: 'monad', selectedCandidateId: null }, { type: 'confirm' })
  ).toEqual({
    state: { openGroupId: 'monad', selectedCandidateId: null },
    effect: null
  });
});

test('dismiss and reopen clear the previous selection', () => {
  const dismissed = projectMemberTargetDialogTransition(
    { openGroupId: 'monad', selectedCandidateId: 'monad:agt_review000000' },
    { type: 'dismiss' }
  );
  const reopened = projectMemberTargetDialogTransition(dismissed.state, {
    type: 'open',
    groupId: 'mesh-agent:codex'
  });

  expect(dismissed).toEqual({ state: initialProjectMemberTargetDialogState, effect: null });
  expect(reopened).toEqual({
    state: { openGroupId: 'mesh-agent:codex', selectedCandidateId: null },
    effect: null
  });
});
