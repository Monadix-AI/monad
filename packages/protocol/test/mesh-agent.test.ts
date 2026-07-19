import { expect, test } from 'bun:test';

import { daemonHttpContract, httpErrorSchema } from '../src/http.ts';
import {
  attachmentPreviewText,
  attachmentReadResponseSchema,
  managedProjectRuntimePromptInputSchema,
  managedProjectRuntimeSpecSchema,
  meshAgentApprovalResolutionRequestSchema,
  meshAgentAuthSessionViewSchema,
  meshAgentAuthStatusResponseSchema,
  meshAgentLaunchModeSchema,
  meshAgentObservationEventSchema,
  meshAgentPresetSchema,
  meshAgentSettingSchema,
  meshAgentUsageResponseSchema,
  meshAgentViewSchema,
  meshConvenienceEventPageSchema,
  meshSessionViewSchema,
  messageAttachmentRefSchema,
  messageAttachmentSchema,
  NATIVE_AGENT_ATTACHMENT_PREVIEW_MAX,
  NATIVE_AGENT_ATTACHMENTS_MAX,
  NATIVE_AGENT_INLINE_TEXT_MAX,
  nativeAgentAttachmentInputSchema,
  nativeAgentDirectMessageSchema,
  nativeAgentProjectInboxAckRequestSchema,
  nativeAgentProjectInboxAckResponseSchema,
  nativeAgentProjectInboxResponseSchema,
  nativeAgentProjectPostRequestSchema,
  nativeAgentProjectPostResponseSchema,
  nativeAgentProjectReadRequestSchema,
  nativeAgentProjectReadResponseSchema,
  nativeAgentReadRequestSchema,
  nativeAgentReadResponseSchema,
  nativeAgentRuntimeInfoResponseSchema,
  nativeAgentRuntimePromptInputSchema,
  nativeAgentRuntimeSchema,
  nativeAgentRuntimeSpecSchema,
  nativeAgentSendRequestSchema,
  nativeAgentSendResponseSchema,
  startMeshAgentRequestSchema,
  workplaceProjectMembersExtKey,
  workplaceProjectMembersExtSchema
} from '../src/mesh-agent/index.ts';

test('MeshAgent launch modes exclude the defunct remote-control mode', () => {
  expect(meshAgentLaunchModeSchema.options).toEqual(['pty', 'json-stream', 'app-server', 'cli-oneshot']);
});

test('MeshAgent view requires provider-owned full-capability defaults', () => {
  const parsed = meshAgentViewSchema.parse({
    name: 'codex',
    provider: 'codex',
    command: 'codex',
    reasoningEfforts: ['low', 'medium', 'high'],
    enabled: true,
    defaultLaunchMode: 'pty',
    allowAutopilot: false
  });

  expect(parsed.provider).toBe('codex');
  expect(parsed.reasoningEfforts).toEqual(['low', 'medium', 'high']);
  expect(parsed.defaultLaunchMode).toBe('pty');
  expect(parsed.approvalOwnership).toBe('provider-owned');
});

test('MeshAgent view accepts Gemini as a provider-owned MeshAgent provider', () => {
  const parsed = meshAgentViewSchema.parse({
    name: 'gemini',
    provider: 'gemini',
    command: 'gemini',
    enabled: true
  });

  expect(parsed.provider).toBe('gemini');
  expect(parsed.defaultLaunchMode).toBe('pty');
  expect(parsed.approvalOwnership).toBe('provider-owned');
});

test('MeshAgent view accepts Qwen as a provider-owned MeshAgent provider', () => {
  const parsed = meshAgentViewSchema.parse({
    name: 'qwen',
    provider: 'qwen',
    command: 'qwen',
    enabled: true
  });

  expect(parsed.provider).toBe('qwen');
  expect(parsed.defaultLaunchMode).toBe('pty');
  expect(parsed.approvalOwnership).toBe('provider-owned');
});

test('MeshAgent view carries project member templates defined on the CLI agent page', () => {
  const parsed = meshAgentViewSchema.parse({
    name: 'codex',
    provider: 'codex',
    command: 'codex',
    enabled: true,
    projectTemplates: [
      {
        id: 'reviewer',
        displayName: 'Reviewer',
        modelId: 'gpt-5.5',
        reasoningEffort: 'high',
        speed: 'fast',
        customPrompt: 'Review changes only.'
      }
    ]
  });

  expect(parsed.projectTemplates).toEqual([
    {
      id: 'reviewer',
      displayName: 'Reviewer',
      modelId: 'gpt-5.5',
      reasoningEffort: 'high',
      speed: 'fast',
      customPrompt: 'Review changes only.'
    }
  ]);
});

test('MeshAgent view rejects duplicate project member template ids', () => {
  expect(
    meshAgentViewSchema.safeParse({
      name: 'codex',
      provider: 'codex',
      command: 'codex',
      enabled: true,
      projectTemplates: [
        { id: 'reviewer', displayName: 'Reviewer' },
        { id: 'reviewer', displayName: 'Second reviewer' }
      ]
    }).success
  ).toBe(false);
});

test('MeshAgent names are safe single path segments', () => {
  const validAgent = {
    name: 'Claude Code',
    provider: 'claude-code',
    command: 'claude',
    enabled: true
  };

  expect(meshAgentViewSchema.safeParse(validAgent).success).toBe(true);
  expect(
    startMeshAgentRequestSchema.safeParse({
      transcriptTargetId: 'ses_100000000000',
      agentName: 'Claude Code',
      workingPath: '/tmp/project'
    }).success
  ).toBe(true);
  expect(workplaceProjectMembersExtSchema.safeParse([{ type: 'mesh-agent', name: 'Claude Code' }]).success).toBe(true);

  for (const unsafeName of ['../codex', '..\\codex', '.', '..', 'C:codex', 'codex/child', 'codex\\child', 'codex\0x']) {
    expect(meshAgentViewSchema.safeParse({ ...validAgent, name: unsafeName }).success).toBe(false);
    expect(
      startMeshAgentRequestSchema.safeParse({
        transcriptTargetId: 'ses_100000000000',
        agentName: unsafeName,
        workingPath: '/tmp/project'
      }).success
    ).toBe(false);
    expect(workplaceProjectMembersExtSchema.safeParse([{ type: 'mesh-agent', name: unsafeName }]).success).toBe(false);
  }
});

test('MeshAgent preset view includes a provider install page', () => {
  const parsed = meshAgentPresetSchema.parse({
    id: 'codex',
    label: 'Codex',
    provider: 'codex',
    productIcon: 'codex',
    command: 'codex',
    args: [],
    defaultLaunchMode: 'pty',
    supportedLaunchModes: ['pty'],
    reasoningEfforts: ['low', 'medium', 'high'],
    installHint: 'Install Codex.',
    installUrl: 'https://developers.openai.com/codex/cli',
    installed: false
  });

  expect(parsed.installUrl).toBe('https://developers.openai.com/codex/cli');
  expect(parsed.reasoningEfforts).toEqual(['low', 'medium', 'high']);
});

test('MeshAgent adapter settings are declared as text, switch, or closed select controls', () => {
  expect(
    meshAgentSettingSchema.parse({
      key: 'command',
      label: 'Command',
      kind: 'text',
      placeholder: 'codex'
    }).kind
  ).toBe('text');

  expect(
    meshAgentSettingSchema.parse({
      key: 'allowAutopilot',
      label: 'Autopilot',
      kind: 'switch',
      defaultValue: true
    }).kind
  ).toBe('switch');

  const preset = meshAgentPresetSchema.parse({
    id: 'codex',
    label: 'Codex',
    provider: 'codex',
    productIcon: 'codex',
    command: 'codex',
    args: [],
    defaultLaunchMode: 'pty',
    supportedLaunchModes: ['pty', 'app-server'],
    installHint: 'Install Codex.',
    installUrl: 'https://developers.openai.com/codex/cli',
    installed: false,
    settings: [
      {
        key: 'defaultLaunchMode',
        label: 'Launch mode',
        kind: 'select',
        options: [
          { value: 'pty', label: 'PTY' },
          { value: 'app-server', label: 'App server' }
        ]
      }
    ]
  });

  expect(preset.settings?.[0]).toEqual({
    key: 'defaultLaunchMode',
    label: 'Launch mode',
    kind: 'select',
    options: [
      { value: 'pty', label: 'PTY' },
      { value: 'app-server', label: 'App server' }
    ]
  });
  expect(
    meshAgentSettingSchema.safeParse({
      key: 'defaultLaunchMode',
      label: 'Launch mode',
      kind: 'select',
      options: []
    }).success
  ).toBe(false);
});

test('MeshAgent view carries adapter setting values separately from declarations', () => {
  const parsed = meshAgentViewSchema.parse({
    name: 'codex',
    provider: 'codex',
    command: 'codex',
    enabled: true,
    adapterSettings: {
      configProfile: 'work',
      useExperimentalGateway: true
    },
    settings: [
      { key: 'configProfile', label: 'Config profile', kind: 'text' },
      { key: 'useExperimentalGateway', label: 'Experimental gateway', kind: 'switch' }
    ]
  });

  expect(parsed.adapterSettings).toEqual({
    configProfile: 'work',
    useExperimentalGateway: true
  });
  expect(parsed.settings?.map((setting) => setting.key)).toEqual(['configProfile', 'useExperimentalGateway']);
});

test('MeshAgent approval resolution request carries provider request id and decision', () => {
  expect(
    meshAgentApprovalResolutionRequestSchema.parse({ requestId: 'req_1', allow: true, reason: 'approved by user' })
  ).toEqual({ requestId: 'req_1', allow: true, reason: 'approved by user' });
});

test('start request requires an absolute working path', () => {
  expect(
    startMeshAgentRequestSchema.safeParse({
      transcriptTargetId: 'ses_100000000000',
      agentName: 'codex',
      workingPath: 'relative/path'
    }).success
  ).toBe(false);
  expect(
    startMeshAgentRequestSchema.safeParse({
      transcriptTargetId: 'ses_100000000000',
      agentName: 'codex',
      workingPath: '/tmp/project'
    }).success
  ).toBe(true);
  expect(
    startMeshAgentRequestSchema.parse({
      agentName: 'codex',
      transcriptTargetId: 'ses_100000000000',
      workingPath: '/tmp/project',
      providerSessionRef: 'provider-session-1'
    }).providerSessionRef
  ).toBe('provider-session-1');
});

test('MeshAgent session view preserves provider session lifecycle fields', () => {
  const parsed = meshSessionViewSchema.parse({
    id: 'mesh_100000000000',
    sessionId: 'ses_SESSION00000',
    agentName: 'claude-code',
    provider: 'claude-code',
    workingPath: '/tmp/project',
    launchMode: 'pty',
    state: 'running',
    pid: 123,
    providerSessionRef: 'abc',
    outputSnapshot: 'hello',
    exitCode: null,
    startedAt: '2026-06-28T00:00:00.000Z',
    updatedAt: '2026-06-28T00:00:01.000Z',
    exitedAt: null
  });

  expect(parsed.approvalOwnership).toBe('provider-owned');
  expect(parsed.sessionId).toBe('ses_SESSION00000');
  expect('projectSessionId' in parsed).toBe(false);
  expect('projectId' in parsed).toBe(false);
  expect(parsed.runtimeRole).toBe('interactive');
});

test('MeshAgent session view carries managed project runtime fields', () => {
  const parsed = meshSessionViewSchema.parse({
    id: 'mesh_100000000000',
    sessionId: 'ses_SESSION00000',
    agentName: 'codex',
    provider: 'codex',
    workingPath: '/tmp/project',
    launchMode: 'app-server',
    runtimeRole: 'managed-project-agent',
    agentRuntimeId: 'nclirt_codex_project',
    lastDeliveredSeq: 42,
    lastVisibleSeq: 40,
    state: 'running',
    pid: 123,
    providerSessionRef: 'provider-thread',
    outputSnapshot: '',
    exitCode: null,
    startedAt: '2026-06-28T00:00:00.000Z',
    updatedAt: '2026-06-28T00:00:01.000Z',
    exitedAt: null
  });

  expect(parsed.runtimeRole).toBe('managed-project-agent');
  expect(parsed.sessionId).toBe('ses_SESSION00000');
  expect('projectSessionId' in parsed).toBe(false);
  expect('projectId' in parsed).toBe(false);
  expect(parsed.agentRuntimeId).toBe('nclirt_codex_project');
  expect(parsed.lastDeliveredSeq).toBe(42);
  expect(parsed.lastVisibleSeq).toBe(40);
});

test('MeshAgent usage response carries optional quota-style records', () => {
  const parsed = meshAgentUsageResponseSchema.parse({
    agentName: 'codex',
    provider: 'codex',
    checkedAt: '2026-07-03T00:00:00.000Z',
    records: [
      {
        name: 'five_hour',
        resetAt: '2026-07-03T05:00:00.000Z',
        max: 100,
        current: 42
      },
      {
        name: 'credits',
        current: 12
      }
    ]
  });

  expect(parsed.records[0]?.name).toBe('five_hour');
  expect(parsed.records[0]?.resetAt).toBe('2026-07-03T05:00:00.000Z');
  expect(meshAgentUsageResponseSchema.safeParse({ ...parsed, records: [{ name: '', current: 1 }] }).success).toBe(
    false
  );
});

test('native agent runtime contract is a raw-output-free host summary', () => {
  const parsed = nativeAgentRuntimeSchema.parse({
    id: 'mesh_100000000000',
    sessionId: 'ses_SESSION00000',
    agentName: 'codex',
    provider: 'codex',
    workingPath: '/tmp/project',
    launchMode: 'app-server',
    runtimeRole: 'managed-project-agent',
    agentRuntimeId: 'nclirt_codex_project',
    state: 'running',
    session: { providerSessionRef: 'provider-thread' },
    lastDeliveredSeq: 42,
    lastVisibleSeq: 40,
    pendingApprovalCount: 0,
    outputSnapshot: '{"raw":"provider event"}',
    pid: 123,
    exitCode: null,
    startedAt: '2026-06-28T00:00:00.000Z',
    updatedAt: '2026-06-28T00:00:01.000Z',
    exitedAt: null
  });

  expect(parsed.session.providerSessionRef).toBe('provider-thread');
  expect(parsed.runtimeRole).toBe('managed-project-agent');
  expect('outputSnapshot' in parsed).toBe(false);
  expect('pid' in parsed).toBe(false);
  expect('exitCode' in parsed).toBe(false);
});

test('MeshAgent observation events carry stable identity and explicit unknown projection', () => {
  expect(
    meshAgentObservationEventSchema.parse({
      id: 'evt_render_1',
      dedupeKey: 'turn_1:item_1',
      projection: 'normalized',
      role: 'agent',
      text: 'done',
      source: 'codex-app-server',
      provenance: { rawEvents: [{ method: 'item/completed', params: { item: { id: 'item-1' } } }] }
    })
  ).toEqual({
    id: 'evt_render_1',
    dedupeKey: 'turn_1:item_1',
    projection: 'normalized',
    role: 'agent',
    text: 'done',
    source: 'codex-app-server',
    provenance: { rawEvents: [{ method: 'item/completed', params: { item: { id: 'item-1' } } }] }
  });

  const raw = { method: 'future/provider/event', params: { value: 1 } };
  expect(
    meshAgentObservationEventSchema.parse({
      id: 'evt_unknown_1',
      dedupeKey: 'future/provider/event:1',
      projection: 'unknown',
      role: 'system',
      text: 'future/provider/event',
      source: 'codex-app-server',
      provenance: { rawEvents: [raw] }
    })
  ).toEqual({
    id: 'evt_unknown_1',
    dedupeKey: 'future/provider/event:1',
    projection: 'unknown',
    role: 'system',
    text: 'future/provider/event',
    source: 'codex-app-server',
    provenance: { rawEvents: [raw] }
  });
});

test('MeshAgent observation events require exact non-empty raw provenance', () => {
  const rawEvents = [
    { type: 'assistant', uuid: 'evt-1', message: { role: 'assistant', content: [] } },
    { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 42, uuid: 'evt-2' }
  ];
  expect(
    meshAgentObservationEventSchema.parse({
      id: 'evt_with_sources',
      role: 'agent',
      text: 'Thinking… · 42 tokens',
      source: 'claude-code-sdk',
      provenance: { rawEvents }
    })
  ).toEqual({
    id: 'evt_with_sources',
    role: 'agent',
    text: 'Thinking… · 42 tokens',
    source: 'claude-code-sdk',
    provenance: { rawEvents }
  });
  expect(() =>
    meshAgentObservationEventSchema.parse({
      id: 'evt_without_sources',
      role: 'agent',
      text: 'fabricated',
      source: 'claude-code-sdk'
    })
  ).toThrow();
  expect(() =>
    meshAgentObservationEventSchema.parse({
      id: 'evt_with_empty_sources',
      role: 'agent',
      text: 'fabricated',
      source: 'claude-code-sdk',
      provenance: { rawEvents: [] }
    })
  ).toThrow();
});

test('MeshAgent convenience event page carries server-normalized events, not raw items', () => {
  const event = {
    id: 'mesh_1:json:0:status',
    kind: 'turn-start' as const,
    streaming: false,
    provenance: { contractEvents: [{ method: 'turn/started', params: { turnId: 'turn-1' } }] }
  };
  const parsed = meshConvenienceEventPageSchema.parse({
    frames: [{ kind: 'patch', cursor: 'live:oep_test:1', operations: [{ op: 'upsert', event }] }],
    nextCursor: 'provider:older-1'
  });

  expect(parsed.frames).toEqual([{ kind: 'patch', cursor: 'live:oep_test:1', operations: [{ op: 'upsert', event }] }]);
  expect(parsed.nextCursor).toBe('provider:older-1');
});

test('workplace project members ext schema is shared by web and daemon', () => {
  const parsed = workplaceProjectMembersExtSchema.parse([
    { type: 'acp', name: 'reviewer', settings: { cwd: '/tmp/project', forwardMcp: true } },
    {
      type: 'mesh-agent',
      name: 'codex',
      settings: { launchMode: 'app-server', managedProjectAgent: true, osSandbox: false }
    }
  ]);

  expect(workplaceProjectMembersExtKey).toBe('workplaceProjectMembers');
  expect(parsed[1]?.settings?.launchMode).toBe('app-server');
  expect(workplaceProjectMembersExtSchema.safeParse([{ type: 'mesh-agent', name: '' }]).success).toBe(false);
  expect(
    workplaceProjectMembersExtSchema.safeParse([{ type: 'mesh-agent', name: 'codex', settings: { launchMode: 'bad' } }])
      .success
  ).toBe(false);
});

test('workplace MeshAgent members can be instantiated multiple times from one template', () => {
  const parsed = workplaceProjectMembersExtSchema.parse([
    {
      type: 'mesh-agent',
      name: 'codex-reviewer',
      templateName: 'codex',
      projectTemplateId: 'reviewer',
      displayName: 'codex-reviewer',
      instanceId: 'pmem_codex_reviewer',
      settings: { modelName: 'gpt-5.5', reasoningEffort: 'high', speed: 'fast', customPrompt: 'Review changes only.' }
    },
    {
      type: 'mesh-agent',
      name: 'codex-tester',
      templateName: 'codex',
      projectTemplateId: 'tester',
      displayName: 'codex-tester',
      instanceId: 'pmem_codex_tester'
    }
  ]);

  expect(
    parsed.map((member) => [
      member.name,
      member.templateName,
      member.projectTemplateId,
      member.displayName,
      member.instanceId
    ])
  ).toEqual([
    ['codex-reviewer', 'codex', 'reviewer', 'codex-reviewer', 'pmem_codex_reviewer'],
    ['codex-tester', 'codex', 'tester', 'codex-tester', 'pmem_codex_tester']
  ]);
  expect(parsed[0]?.settings?.customPrompt).toBe('Review changes only.');
  expect(parsed[0]?.settings?.modelName).toBe('gpt-5.5');
  expect(parsed[0]?.settings?.reasoningEffort).toBe('high');
  expect(parsed[0]?.settings?.speed).toBe('fast');
});

test('MeshAgent auth views model provider-owned login relay without project session fields', () => {
  const session = meshAgentAuthSessionViewSchema.parse({
    id: 'ncliauth_100000000000',
    controlToken: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    agentName: 'codex',
    provider: 'codex',
    state: 'running',
    pid: 123,
    outputSnapshot: 'Open this URL to sign in',
    exitCode: null,
    startedAt: '2026-06-28T00:00:00.000Z',
    updatedAt: '2026-06-28T00:00:01.000Z',
    exitedAt: null
  });
  expect(session.approvalOwnership).toBe('provider-owned');
  expect('projectSessionId' in session).toBe(false);

  expect(
    meshAgentAuthStatusResponseSchema.parse({
      agentName: 'claude-code',
      provider: 'claude-code',
      state: 'unauthenticated',
      output: 'not logged in',
      checkedAt: '2026-06-28T00:00:02.000Z'
    }).state
  ).toBe('unauthenticated');
});

test('native agent runtime prompt and prepared spec are protocol contracts', () => {
  expect(managedProjectRuntimePromptInputSchema).toBe(nativeAgentRuntimePromptInputSchema);
  expect(managedProjectRuntimeSpecSchema).toBe(nativeAgentRuntimeSpecSchema);

  const promptInput = nativeAgentRuntimePromptInputSchema.parse({
    agentName: 'codex',
    projectId: 'prj_PROJECT00000',
    meshSessionId: 'mesh_100000000000',
    provider: 'codex',
    workspace: '/tmp/monad/workplace-agents/prj_PROJECT00000/codex',
    modelName: 'gpt-5.5',
    reasoningEffort: 'high',
    speed: 'fast'
  });

  expect(promptInput.projectId).toBe('prj_PROJECT00000');
  expect('projectSessionId' in promptInput).toBe(false);
  expect(promptInput.provider).toBe('codex');
  expect(promptInput.modelName).toBe('gpt-5.5');
  expect(promptInput.reasoningEffort).toBe('high');
  expect(promptInput.speed).toBe('fast');

  const spec = nativeAgentRuntimeSpecSchema.parse({
    workspace: '/tmp/monad/workplace-agents/prj_PROJECT00000/codex',
    promptFile: '/tmp/monad/workplace-agents/prj_PROJECT00000/codex/managed-prompt.md',
    tokenFile: '/tmp/monad/workplace-agents/prj_PROJECT00000/codex/.monad-agent-token',
    tokenHash: 'abc123',
    monadCliEntry: {
      command: '/Applications/Monad.app/Contents/MacOS/Monad',
      args: []
    },
    env: {
      MONAD_MESH_SESSION_ID: 'mesh_100000000000'
    },
    prompt: 'Use monad project post for public replies.'
  });

  expect(spec.env.MONAD_MESH_SESSION_ID).toBe('mesh_100000000000');
  expect(nativeAgentRuntimeSpecSchema.safeParse({ ...spec, env: undefined }).success).toBe(false);
});

test('native agent project command schemas allow runtime-bound project defaults and require non-empty text', () => {
  expect(
    nativeAgentProjectPostRequestSchema.parse({
      sessionId: 'ses_PROJECT00000',
      threadId: 'msg_PARENT000000',
      text: 'hello project'
    })
  ).toEqual({ sessionId: 'ses_PROJECT00000', threadId: 'msg_PARENT000000', text: 'hello project' });

  expect(nativeAgentProjectPostRequestSchema.safeParse({ sessionId: 'not-a-session', text: 'hello' }).success).toBe(
    false
  );
  expect(nativeAgentProjectPostRequestSchema.parse({ text: 'hello' })).toEqual({ text: 'hello' });
  expect(nativeAgentProjectPostRequestSchema.safeParse({ sessionId: 'ses_PROJECT00000', text: '' }).success).toBe(
    false
  );
  expect(
    nativeAgentProjectReadRequestSchema.parse({
      sessionId: 'ses_PROJECT00000',
      after: 'msg_OLD000000000',
      limit: 25
    }).limit
  ).toBe(25);
});

test('native agent inbox and runtime info schemas carry project-managed runtime state', () => {
  const inbox = nativeAgentProjectInboxResponseSchema.parse({
    sessionId: 'ses_PROJECT00000',
    cursor: 7,
    items: [
      {
        seq: 7,
        message: {
          id: 'msg_INBOX0000000',
          sessionId: 'ses_SESSION00000',
          role: 'user',
          text: 'please take a look',
          type: 'text',
          stream: { status: 'settled' },
          active: true,
          createdAt: '2026-06-28T00:00:00.000Z'
        }
      }
    ]
  });

  expect(inbox.items[0]?.message.id).toBe('msg_INBOX0000000');

  const info = nativeAgentRuntimeInfoResponseSchema.parse({
    agentId: 'codex',
    sessionId: 'ses_PROJECT00000',
    meshSessionId: 'mesh_100000000000',
    serverUrl: 'http://127.0.0.1:3000',
    workdir: '/tmp/project',
    providerSessionRef: null,
    lastDeliveredSeq: 9,
    lastVisibleSeq: 7,
    pendingInboxCount: 2
  });

  expect(info.pendingInboxCount).toBe(2);
  expect('projectSessionId' in info).toBe(false);
});

test('native agent direct message schemas stay separate from project transcript', () => {
  expect(nativeAgentSendRequestSchema.parse({ to: 'human', text: 'private note' })).toEqual({
    to: 'human',
    text: 'private note'
  });

  const message = nativeAgentDirectMessageSchema.parse({
    id: 'msg_DIRECT000000',
    sessionId: 'ses_PROJECT00000',
    meshSessionId: 'mesh_100000000000',
    fromAgent: 'codex',
    peer: 'human',
    text: 'private note',
    createdAt: '2026-06-28T00:00:00.000Z'
  });

  expect(message.sessionId).toBe('ses_PROJECT00000');
  expect('projectSessionId' in message).toBe(false);
  expect(message.peer).toBe('human');
});

test('messages carry file attachment references; the inline cap stays as the fallback guard', () => {
  const overInline = 'x'.repeat(NATIVE_AGENT_INLINE_TEXT_MAX + 1);

  // Inline path keeps its DoS cap.
  expect(nativeAgentProjectPostRequestSchema.safeParse({ text: overInline }).success).toBe(false);
  expect(nativeAgentSendRequestSchema.safeParse({ to: 'human', text: overInline }).success).toBe(false);

  // File references can replace (or accompany) the inline body, several per message.
  expect(
    nativeAgentProjectPostRequestSchema.parse({ attachments: [{ path: '/tmp/report.md' }, { path: '/tmp/log.txt' }] })
  ).toEqual({ attachments: [{ path: '/tmp/report.md' }, { path: '/tmp/log.txt' }] });
  expect(
    nativeAgentSendRequestSchema.parse({ to: 'human', text: 'see report', attachments: [{ path: '/tmp/report.md' }] })
  ).toEqual({ to: 'human', text: 'see report', attachments: [{ path: '/tmp/report.md' }] });

  // Attachment paths are cross-platform absolute; relative paths are rejected.
  expect(nativeAgentAttachmentInputSchema.safeParse({ path: 'relative/report.md' }).success).toBe(false);
  expect(nativeAgentAttachmentInputSchema.safeParse({ path: 'C:\\work\\report.md' }).success).toBe(true);

  // One of text/attachments is required; the list is non-empty and capped.
  expect(nativeAgentProjectPostRequestSchema.safeParse({}).success).toBe(false);
  expect(nativeAgentSendRequestSchema.safeParse({ to: 'human' }).success).toBe(false);
  expect(nativeAgentProjectPostRequestSchema.safeParse({ attachments: [] }).success).toBe(false);
  expect(
    nativeAgentProjectPostRequestSchema.safeParse({
      attachments: Array.from({ length: NATIVE_AGENT_ATTACHMENTS_MAX + 1 }, (_, i) => ({ path: `/tmp/f${i}` }))
    }).success
  ).toBe(false);
});

test('attachment previews are bounded snippets and never split a surrogate pair', () => {
  expect(attachmentPreviewText('short')).toBe('short');
  const long = 'y'.repeat(NATIVE_AGENT_ATTACHMENT_PREVIEW_MAX + 100);
  const preview = attachmentPreviewText(long);
  expect(preview.length).toBe(NATIVE_AGENT_ATTACHMENT_PREVIEW_MAX + 1);
  expect(preview.endsWith('…')).toBe(true);

  // '😀' is a surrogate pair; an odd-position cut must back off instead of leaving a lone surrogate.
  const emoji = '😀'.repeat(NATIVE_AGENT_ATTACHMENT_PREVIEW_MAX);
  const emojiPreview = attachmentPreviewText(emoji);
  const lastBeforeEllipsis = emojiPreview.charCodeAt(emojiPreview.length - 2);
  expect(lastBeforeEllipsis >= 0xd800 && lastBeforeEllipsis <= 0xdbff).toBe(false);
});

test('attachment refs and direct messages carry the structured file reference', () => {
  const ref = messageAttachmentRefSchema.parse({
    id: 'att_01ABC0000000' as const,
    path: '/tmp/project/report.md',
    name: 'report.md',
    mime: 'text/markdown',
    bytes: 12345,
    createdAt: '2026-06-28T00:00:00.000Z'
  });
  const message = nativeAgentDirectMessageSchema.parse({
    id: 'msg_DIRECT000000',
    sessionId: 'ses_PROJECT00000',
    meshSessionId: 'mesh_100000000000',
    fromAgent: 'codex',
    peer: 'human',
    text: 'preview…',
    attachments: [ref],
    createdAt: '2026-06-28T00:00:00.000Z'
  });
  expect(message.attachments?.[0]?.path).toBe('/tmp/project/report.md');
});

test('message attachment presentations allow metadata without claiming a readable file reference', () => {
  const presentation = {
    id: 'att_01ABC0000000' as const,
    name: 'diagram.png',
    mime: 'image/png',
    bytes: 4321,
    createdAt: '2026-07-19T00:00:00.000Z'
  };

  expect(messageAttachmentSchema.parse(presentation)).toEqual(presentation);
  expect(messageAttachmentRefSchema.safeParse(presentation).success).toBe(false);
  expect(messageAttachmentSchema.parse({ ...presentation, path: '/tmp/diagram.png' })).toEqual({
    ...presentation,
    path: '/tmp/diagram.png'
  });
});

test('native agent HTTP endpoints are declared in the protocol daemon contract', () => {
  expect(daemonHttpContract.nativeAgent.projectPost.body).toBe(nativeAgentProjectPostRequestSchema);
  expect(daemonHttpContract.nativeAgent.projectPost.response).toEqual({
    200: nativeAgentProjectPostResponseSchema,
    403: httpErrorSchema,
    404: httpErrorSchema
  });
  expect(daemonHttpContract.nativeAgent.projectRead.body).toBe(nativeAgentProjectReadRequestSchema);
  expect(daemonHttpContract.nativeAgent.projectRead.response[200]).toBe(nativeAgentProjectReadResponseSchema);
  expect(daemonHttpContract.nativeAgent.projectInbox.response[200]).toBe(nativeAgentProjectInboxResponseSchema);
  expect(daemonHttpContract.nativeAgent.projectInboxAck.body).toBe(nativeAgentProjectInboxAckRequestSchema);
  expect(daemonHttpContract.nativeAgent.projectInboxAck.response[200]).toBe(nativeAgentProjectInboxAckResponseSchema);
  expect(daemonHttpContract.nativeAgent.agentSend.body).toBe(nativeAgentSendRequestSchema);
  expect(daemonHttpContract.nativeAgent.agentSend.response[200]).toBe(nativeAgentSendResponseSchema);
  expect(daemonHttpContract.nativeAgent.agentRead.body).toBe(nativeAgentReadRequestSchema);
  expect(daemonHttpContract.nativeAgent.agentRead.response[200]).toBe(nativeAgentReadResponseSchema);
  expect(daemonHttpContract.nativeAgent.runtimeInfo.response[200]).toBe(nativeAgentRuntimeInfoResponseSchema);
  expect(daemonHttpContract.nativeAgent.attachmentRead.response[200]).toBe(attachmentReadResponseSchema);
});

// The workingPath schema is cross-platform: it travels over the wire from any client OS, so it must
// accept both POSIX and Windows absolute paths (the daemon re-checks with path.isAbsolute for its own
// platform). Relative paths are always rejected.
const startReq = (workingPath: string) =>
  startMeshAgentRequestSchema.safeParse({
    transcriptTargetId: 'ses_100000000000',
    agentName: 'codex',
    workingPath,
    launchMode: 'pty'
  });

test('startMeshAgentRequest accepts POSIX absolute working paths', () => {
  expect(startReq('/home/user/project').success).toBe(true);
  expect(startReq('/').success).toBe(true);
});

test('startMeshAgentRequest accepts Windows absolute working paths', () => {
  expect(startReq('C:\\Users\\me\\project').success).toBe(true);
  expect(startReq('C:/Users/me/project').success).toBe(true);
  expect(startReq('\\\\server\\share\\project').success).toBe(true);
});

test('startMeshAgentRequest rejects relative working paths', () => {
  for (const rel of ['project', './project', '../project', 'C:project', 'foo/bar']) {
    expect(startReq(rel).success).toBe(false);
  }
});
