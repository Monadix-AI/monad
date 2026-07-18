# External Agent Sleep and Awake System Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render external-agent idle lifecycle notices with the configured member name and avatar plus concise sleep/awake copy.

**Architecture:** Add an optional structured external-agent actor reference to `UISystemItem`, populate it in the daemon lifecycle projection, and resolve it through the same project-member identity metadata used by member-join system events. Keep the existing `SystemMessageRow` and its `agentChip` actor slot; system items without an actor remain compatible.

**Tech Stack:** TypeScript, Zod, React, Bun test, repository i18n catalogs.

## Global Constraints

- Reuse the existing system-event row and member-join actor presentation; do not add a lifecycle-specific card or avatar style.
- English copy is exactly `fell asleep.` and `woke up.`.
- Chinese copy is exactly `睡着了。` and `醒来了。`.
- Configured project-member display name, avatar seed, product icon, and tag win over fallbacks.
- Existing `UISystemItem` payloads without an actor continue to parse and render.
- Follow TDD: observe each regression test fail before changing production code.
- Use Bun-only commands and commit only task-scoped files because `main` contains unrelated concurrent WIP.

---

### Task 1: Carry structured actors through lifecycle system items

**Files:**
- Modify: `packages/protocol/src/ui.ts:121-128`
- Test: `packages/protocol/test/ui.test.ts`
- Modify: `apps/monad/src/handlers/session/ui-projection-tool-events.ts:205-235`
- Test: `apps/monad/test/unit/sessions/ui-projection.test.ts:1575-1615`
- Modify: `packages/i18n/src/locales/en/daemon.json:8-9`
- Modify: `packages/i18n/src/locales/zh/daemon.json:8-9`

**Interfaces:**
- Produces: `UISystemItem['actor']` with shape `{ id: string; kind: 'external-agent' }`.
- Produces: idle lifecycle system items whose `text` is action-only localized copy.
- Consumes: existing `external_agent.idle_suspended` and `external_agent.idle_resumed` payload `agentName` as the stable project-member identifier.

- [ ] **Step 1: Add a failing protocol compatibility test**

Add a test to `packages/protocol/test/ui.test.ts` that parses both a new actor-bearing item and a legacy item:

```ts
test('system items preserve optional external-agent actor references', () => {
  const current = sessionUiEventSchema.parse({
    kind: 'upsert',
    item: {
      kind: 'system',
      id: 'external-agent-idle-suspended:pmem_codex_1:evt_1',
      text: 'fell asleep.',
      actor: { id: 'pmem_codex_1', kind: 'external-agent' },
      seq: 'evt_1'
    }
  });
  const legacy = sessionUiEventSchema.parse({
    kind: 'upsert',
    item: { kind: 'system', id: 'legacy', text: 'Legacy notice', seq: 'evt_0' }
  });

  expect(current).toEqual({
    kind: 'upsert',
    item: {
      kind: 'system',
      id: 'external-agent-idle-suspended:pmem_codex_1:evt_1',
      text: 'fell asleep.',
      actor: { id: 'pmem_codex_1', kind: 'external-agent' },
      seq: 'evt_1'
    }
  });
  expect(legacy).toEqual({
    kind: 'upsert',
    item: { kind: 'system', id: 'legacy', text: 'Legacy notice', seq: 'evt_0' }
  });
});
```

- [ ] **Step 2: Run the protocol test and verify RED**

Run:

```bash
bun scripts/bun-test.ts packages/protocol/test/ui.test.ts --only-failures
```

Expected: FAIL because `uiSystemItemSchema` strips the unsupported `actor` field from the parsed value.

- [ ] **Step 3: Add the optional actor schema**

Update `packages/protocol/src/ui.ts`:

```ts
export const uiSystemActorSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('external-agent')
});
export type UISystemActor = z.infer<typeof uiSystemActorSchema>;

export const uiSystemItemSchema = z.object({
  kind: z.literal('system'),
  id: z.string(),
  text: z.string(),
  actor: uiSystemActorSchema.optional(),
  level: z.enum(['info', 'warn', 'error']).optional(),
  seq: z.string()
});
```

- [ ] **Step 4: Run the protocol test and verify GREEN**

Run the Step 2 command again.

Expected: all tests in `packages/protocol/test/ui.test.ts` pass.

- [ ] **Step 5: Change the daemon regression expectations first**

Update the existing suspend/resume test in `apps/monad/test/unit/sessions/ui-projection.test.ts` to require exact shapes:

```ts
item: {
  kind: 'system',
  id: `external-agent-idle-suspended:reviewer:${suspendedEvent.id}`,
  text: 'fell asleep.',
  actor: { id: 'reviewer', kind: 'external-agent' },
  level: 'info',
  seq: suspendedEvent.id
}
```

and:

```ts
item: {
  kind: 'system',
  id: `external-agent-idle-resumed:reviewer:${resumedEvent.id}`,
  text: 'woke up.',
  actor: { id: 'reviewer', kind: 'external-agent' },
  level: 'info',
  seq: resumedEvent.id
}
```

Add Chinese assertions using a projector created with the `zh` locale and expect `睡着了。` and `醒来了。`.

- [ ] **Step 6: Run the daemon projection test and verify RED**

Run:

```bash
bun scripts/bun-test.ts apps/monad/test/unit/sessions/ui-projection.test.ts --only-failures
```

Expected: FAIL because the items have no actor and the text still includes the raw agent identifier.

- [ ] **Step 7: Emit the actor and action-only localized copy**

Update both lifecycle cases in `ui-projection-tool-events.ts`:

```ts
actor: { id: p.agentName, kind: 'external-agent' },
text: m.t('daemon.session.externalAgentIdleSuspended')
```

and:

```ts
actor: { id: p.agentName, kind: 'external-agent' },
text: m.t('daemon.session.externalAgentIdleResumed')
```

Change the four locale values to the exact copy in Global Constraints and remove the unused `agent` interpolation.

- [ ] **Step 8: Regenerate i18n types and verify Task 1**

Run:

```bash
bun run i18n:types
bun scripts/bun-test.ts packages/protocol/test/ui.test.ts apps/monad/test/unit/sessions/ui-projection.test.ts --only-failures
```

Expected: protocol and daemon projection tests pass with zero failures.

- [ ] **Step 9: Commit Task 1**

Commit only the protocol, daemon projection, test, locale, and generated i18n files changed by this task:

```bash
git commit --only packages/protocol/src/ui.ts packages/protocol/test/ui.test.ts apps/monad/src/handlers/session/ui-projection-tool-events.ts apps/monad/test/unit/sessions/ui-projection.test.ts packages/i18n/src/locales/en/daemon.json packages/i18n/src/locales/zh/daemon.json packages/i18n/generated -m "feat(chat): structure external agent lifecycle actors"
```

### Task 2: Resolve lifecycle actors through project-member identity

**Files:**
- Modify: `packages/atoms/src/workspace-experiences/chat-room/utils/projection.ts:140-170, 374-383, 472-496`
- Test: `packages/atoms/test/unit/workspace-project-messages.test.ts`

**Interfaces:**
- Consumes: `UISystemItem.actor?: { id: string; kind: 'external-agent' }` from Task 1.
- Consumes: existing `projectMembers`, `externalAgentDisplayNames`, `externalAgentAvatarSeeds`, `externalAgentIcons`, `externalAgentTags`, and `avatarStyle` inputs.
- Produces: lifecycle `Message` values with the same `agentChip` identity shape used by member-join system events.

- [ ] **Step 1: Add a failing configured-identity projection test**

Add a test to `workspace-project-messages.test.ts`:

```ts
test('sleep and awake system events reuse configured member identity', () => {
  const avatarUrl = __workplaceProjectMessageTest.entityAvatarUrl('external-agent-instance:reviewer');
  const messages = __workplaceProjectMessageTest.buildProjectMessages({
    persistedMessages: [],
    projectMembers: [{
      id: 'pmem_codex_reviewer',
      type: 'external-agent',
      name: 'codex',
      instanceId: 'pmem_codex_reviewer',
      displayName: 'Reviewer'
    }],
    externalAgentSessions: [],
    liveItems: [{
      kind: 'system',
      id: 'external-agent-idle-suspended:pmem_codex_reviewer:evt_1',
      text: 'fell asleep.',
      actor: { id: 'pmem_codex_reviewer', kind: 'external-agent' },
      level: 'info',
      seq: 'evt_1'
    }],
    liveTools: [],
    externalAgentDisplayNames: new Map([['pmem_codex_reviewer', 'Reviewer']]),
    externalAgentAvatarSeeds: new Map([['Reviewer', 'external-agent-instance:reviewer']]),
    externalAgentIcons: new Map([['pmem_codex_reviewer', 'codex']]),
    externalAgentTags: new Map([['pmem_codex_reviewer', 'Codex']])
  });

  expect(messages).toEqual([{
    id: 'external-agent-idle-suspended:pmem_codex_reviewer:evt_1',
    authorId: 'pmem_codex_reviewer',
    authorName: 'Reviewer',
    av: 'RE',
    icon: 'codex',
    avatarUrl,
    kind: 'system',
    tag: 'Codex',
    time: '',
    text: 'fell asleep.',
    orderKey: 'evt_1',
    agentChip: {
      id: 'pmem_codex_reviewer',
      name: 'Reviewer',
      icon: 'codex',
      avatarUrl,
      tag: 'Codex'
    }
  }]);
});
```

- [ ] **Step 2: Run the atoms test and verify RED**

Run:

```bash
bun scripts/bun-test.ts packages/atoms/test/unit/workspace-project-messages.test.ts --only-failures
```

Expected: FAIL because lifecycle projection uses the raw actor name, a synthetic resume avatar seed, and does not set `agentChip`.

- [ ] **Step 3: Extract the existing member system-event identity builder**

In `projection.ts`, extract the identity logic currently embedded in `projectMemberJoinMessageView` into a focused helper:

```ts
function externalAgentSystemActorView(args: {
  actorId: string;
  projectMembers: readonly ProjectMember[];
  externalAgentDisplayNames: Map<string, string>;
  externalAgentAvatarSeeds: Map<string, string>;
  externalAgentIcons: Map<string, Message['icon']>;
  externalAgentTags: Map<string, string>;
  avatarStyle?: AvatarStyle;
}) {
  const member = args.projectMembers.find((candidate) => candidate.id === args.actorId);
  const memberName = member?.name ?? args.actorId;
  const displayName =
    args.externalAgentDisplayNames.get(args.actorId) ??
    member?.displayName ??
    args.externalAgentDisplayNames.get(memberName) ??
    memberName;
  const icon = args.externalAgentIcons.get(args.actorId) ?? args.externalAgentIcons.get(memberName) ?? iconForAgent(displayName);
  const tag = args.externalAgentTags.get(args.actorId) ?? args.externalAgentTags.get(memberName) ?? 'CLI';
  const avatarUrl = externalAgentAvatarUrl(displayName, args.externalAgentAvatarSeeds, args.avatarStyle);
  return {
    authorId: args.actorId,
    authorName: displayName,
    av: avatarForAgent(displayName),
    icon,
    avatarUrl,
    tag,
    agentChip: { id: args.actorId, name: displayName, icon, avatarUrl, tag }
  };
}
```

Use this helper from the member-join path so join and lifecycle notices cannot drift in actor presentation.

- [ ] **Step 4: Project structured lifecycle actors into `agentChip`**

In the `item.kind === 'system'` branch, prefer `item.actor.id`; retain `externalAgentSystemAgentName(item.id)` only for legacy items. When an external-agent actor is available, merge `externalAgentSystemActorView(...)` into the message and keep `item.text` unchanged. Generic system items continue using the Monad/SYS fallback.

The branch should follow this shape:

```ts
const legacyActorId = externalAgentSystemAgentName(item.id);
const actorId = item.actor?.kind === 'external-agent' ? item.actor.id : legacyActorId;
const actor = actorId
  ? externalAgentSystemActorView({
      actorId,
      projectMembers,
      externalAgentDisplayNames,
      externalAgentAvatarSeeds,
      externalAgentIcons,
      externalAgentTags,
      avatarStyle
    })
  : undefined;

byId.set(item.id, {
  id: item.id,
  ...(actor ?? monadSystemIdentity),
  kind: 'system',
  time: '',
  text: item.text,
  orderKey: item.seq
});
```

- [ ] **Step 5: Add and verify fallback coverage**

Add an exact assertion for an actor-bearing lifecycle item with no project-member metadata. Expect its actor ID as the name, tag `CLI`, an inferred icon when available, a deterministic generated avatar, and a populated `agentChip`. Also retain one legacy lifecycle item without `actor` to prove ID-prefix migration compatibility.

Run:

```bash
bun scripts/bun-test.ts packages/atoms/test/unit/workspace-project-messages.test.ts --only-failures
```

Expected: all workspace project message tests pass.

- [ ] **Step 6: Run focused cross-layer verification**

Run:

```bash
bun scripts/bun-test.ts packages/protocol/test/ui.test.ts apps/monad/test/unit/sessions/ui-projection.test.ts packages/atoms/test/unit/workspace-project-messages.test.ts --only-failures
bunx biome check packages/protocol/src/ui.ts packages/protocol/test/ui.test.ts apps/monad/src/handlers/session/ui-projection-tool-events.ts apps/monad/test/unit/sessions/ui-projection.test.ts packages/atoms/src/workspace-experiences/chat-room/utils/projection.ts packages/atoms/test/unit/workspace-project-messages.test.ts packages/i18n/src/locales/en/daemon.json packages/i18n/src/locales/zh/daemon.json
```

Expected: zero test failures and no Biome diagnostics.

- [ ] **Step 7: Commit Task 2**

```bash
git commit --only packages/atoms/src/workspace-experiences/chat-room/utils/projection.ts packages/atoms/test/unit/workspace-project-messages.test.ts -m "fix(chat): show member identity on sleep events"
```

### Task 3: Verify the integrated result

**Files:**
- Verify only; no planned production edits.

**Interfaces:**
- Consumes: the Task 1 `UISystemItem.actor` contract and Task 2 `agentChip` projection.
- Produces: fresh repository-gate evidence for the exact committed `main` revision.

- [ ] **Step 1: Create a clean detached verification worktree**

Because the main checkout contains unrelated WIP, create a temporary detached worktree at the exact implementation commit and install from Bun's cache:

```bash
verify_dir=$(mktemp -d /tmp/monad-sleep-awake-verify.XXXXXX)
git worktree add --detach "$verify_dir" HEAD
cd "$verify_dir"
bun install --ignore-scripts
```

- [ ] **Step 2: Run the complete repository gates sequentially**

```bash
bun run lint
bun run typecheck
bun run test
```

Expected: lint applies no fixes, all typecheck tasks pass, and all test tasks pass.

- [ ] **Step 3: Audit and clean the verification worktree**

```bash
git status --short
git diff --check
```

Expected: no output. Return to `/Users/zeke/Projects/monad`, remove only the temporary worktree created in Step 1 with `git worktree remove "$verify_dir"`, and run `git worktree prune`.

- [ ] **Step 4: Confirm scope and ancestry**

Verify both implementation commits are ancestors of current `main`, no later commit changed the scoped files, and unrelated staged/unstaged WIP remains untouched.
