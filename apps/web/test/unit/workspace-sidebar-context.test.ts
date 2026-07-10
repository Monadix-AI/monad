import { describe, expect, test } from 'bun:test';

import { WORKSPACE_SIDEBAR_CONTEXT_GROUPS } from '../../src/features/shell/sidebar/workspace-sidebar-context';

describe('workspace sidebar context', () => {
  test('separates state, actions, and metadata', () => {
    expect(WORKSPACE_SIDEBAR_CONTEXT_GROUPS).toEqual(['state', 'actions', 'meta']);
  });
});
