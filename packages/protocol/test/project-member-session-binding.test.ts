import { expect, test } from 'bun:test';

import {
  PROJECT_MEMBER_ID_MAX_LENGTH,
  projectMemberIdSchema,
  projectMemberSchema,
  sessionBindingSchema
} from '../src/index.ts';

const now = '2026-07-27T07:00:00.000Z';

test('one profile creates distinct project members with independent collaboration overrides', () => {
  const first = projectMemberSchema.parse({
    id: 'mesh-agent:codex',
    projectId: 'prj_review000001',
    profileId: 'codex',
    type: 'mesh-agent',
    displayName: 'Reviewer A',
    customPrompt: 'Review correctness.',
    launchOverrides: { modelId: 'gpt-5.4' },
    workingDirectoryOverride: '/workspace/review-a',
    lifecycle: 'enabled',
    createdAt: now,
    updatedAt: now
  });
  const second = projectMemberSchema.parse({
    ...first,
    id: 'pmem_review_b',
    displayName: 'Reviewer B',
    customPrompt: null,
    launchOverrides: {},
    workingDirectoryOverride: null
  });

  expect([first, second]).toEqual([
    {
      id: 'mesh-agent:codex',
      projectId: 'prj_review000001',
      profileId: 'codex',
      type: 'mesh-agent',
      displayName: 'Reviewer A',
      customPrompt: 'Review correctness.',
      launchOverrides: { modelId: 'gpt-5.4' },
      workingDirectoryOverride: '/workspace/review-a',
      lifecycle: 'enabled',
      createdAt: now,
      updatedAt: now
    },
    {
      id: 'pmem_review_b',
      projectId: 'prj_review000001',
      profileId: 'codex',
      type: 'mesh-agent',
      displayName: 'Reviewer B',
      customPrompt: null,
      launchOverrides: {},
      workingDirectoryOverride: null,
      lifecycle: 'enabled',
      createdAt: now,
      updatedAt: now
    }
  ]);
});

test('one project member binds to two sessions with independent cursors and native runtimes', () => {
  const first = sessionBindingSchema.parse({
    sessionId: 'ses_review000001',
    projectMemberId: 'pmem_review_a',
    lastDeliveredSeq: 12,
    lastVisibleSeq: 10,
    currentNativeRuntimeSessionId: 'mesh_review000001',
    lifecycle: 'active',
    lastHealth: 'running',
    createdAt: now,
    updatedAt: now
  });
  const second = sessionBindingSchema.parse({
    ...first,
    sessionId: 'ses_review000002',
    lastDeliveredSeq: 4,
    lastVisibleSeq: 4,
    currentNativeRuntimeSessionId: 'mesh_review000002',
    lastHealth: 'starting'
  });

  expect([first, second]).toEqual([
    {
      sessionId: 'ses_review000001',
      projectMemberId: 'pmem_review_a',
      lastDeliveredSeq: 12,
      lastVisibleSeq: 10,
      currentNativeRuntimeSessionId: 'mesh_review000001',
      lifecycle: 'active',
      lastHealth: 'running',
      createdAt: now,
      updatedAt: now
    },
    {
      sessionId: 'ses_review000002',
      projectMemberId: 'pmem_review_a',
      lastDeliveredSeq: 4,
      lastVisibleSeq: 4,
      currentNativeRuntimeSessionId: 'mesh_review000002',
      lifecycle: 'active',
      lastHealth: 'starting',
      createdAt: now,
      updatedAt: now
    }
  ]);
});

test('project member ids preserve supported legacy ids within an explicit shared bound', () => {
  const legacyId = `mesh-agent:${'x'.repeat(256)}`;
  expect([projectMemberIdSchema.parse(legacyId), projectMemberIdSchema.parse('pmem_review_a')]).toEqual([
    legacyId,
    'pmem_review_a'
  ]);
  expect(projectMemberIdSchema.safeParse('x'.repeat(PROJECT_MEMBER_ID_MAX_LENGTH + 1)).success).toBe(false);
});
