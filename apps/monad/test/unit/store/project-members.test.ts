import type { ProjectMember, WorkplaceProject } from '@monad/protocol';

import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createStore } from '#/store/db/index.ts';

const now = '2026-07-27T07:00:00.000Z';
const later = '2026-07-27T08:00:00.000Z';
const project: WorkplaceProject = {
  id: 'prj_members00000',
  title: 'Members',
  state: 'active',
  archived: false,
  memberTemplates: [],
  createdAt: now,
  updatedAt: now
};
const first: ProjectMember = {
  id: 'pmem_review_a',
  projectId: project.id,
  profileId: 'codex',
  type: 'mesh-agent',
  displayName: 'Reviewer A',
  customPrompt: 'Review correctness.',
  launchOverrides: { modelId: 'gpt-5.4' },
  workingDirectoryOverride: '/workspace/review-a',
  lifecycle: 'enabled',
  createdAt: now,
  updatedAt: now
};

let store: ReturnType<typeof createStore>;

beforeEach(() => {
  store = createStore();
  store.insertWorkplaceProject(project);
});

afterEach(() => store.close());

test('two members from one profile retain independent identity and overrides', () => {
  const second: ProjectMember = {
    ...first,
    id: 'pmem_review_b',
    displayName: 'Reviewer B',
    customPrompt: null,
    launchOverrides: {},
    workingDirectoryOverride: null
  };

  store.insertProjectMember(first);
  store.insertProjectMember(second);
  const updated = store.updateProjectMember(project.id, first.id, {
    customPrompt: 'Review correctness and security.',
    launchOverrides: { modelId: 'gpt-5.4', reasoningEffort: 'high' },
    lifecycle: 'disabled',
    updatedAt: later
  });

  expect({ updated, members: store.listProjectMembers(project.id) }).toEqual({
    updated: {
      ...first,
      customPrompt: 'Review correctness and security.',
      launchOverrides: { modelId: 'gpt-5.4', reasoningEffort: 'high' },
      lifecycle: 'disabled',
      updatedAt: later
    },
    members: [
      {
        ...first,
        customPrompt: 'Review correctness and security.',
        launchOverrides: { modelId: 'gpt-5.4', reasoningEffort: 'high' },
        lifecycle: 'disabled',
        updatedAt: later
      },
      second
    ]
  });
  expect(store.getProjectMember(project.id, second.id)).toEqual(second);
});
