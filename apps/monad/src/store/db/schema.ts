import { sql } from 'drizzle-orm';
// biome-ignore lint/suspicious/noDeprecatedImports: drizzle marks the named export deprecated but the object-form API we use is correct
import { blob, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const providerSessionRefNotNull = sql`provider_session_ref IS NOT NULL`;
const liveMeshSession = sql`state IN ('starting', 'running')`;
const liveAcpDelegate = sql`evicted_at IS NULL`;
const deliveryIdNotNull = sql`delivery_id IS NOT NULL`;
const unresolvedNativeAgentAsk = sql`resolved_at IS NULL`;
const ingressMessageIdNotNull = sql`message_id IS NOT NULL`;
const ingressDirectMessageIdNotNull = sql`direct_message_id IS NOT NULL`;
const directMessageRequestIdNotNull = sql`request_id IS NOT NULL`;

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id'),
    title: text('title').notNull(),
    state: text('state').notNull(),
    agentIds: text('agent_ids').notNull().default('[]'),
    archived: integer('archived').notNull().default(0),
    restoreCount: integer('restore_count').notNull().default(0),
    model: text('model'),
    cwd: text('cwd'),
    origin: text('origin'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    reasoningTokens: integer('reasoning_tokens').notNull().default(0),
    costUsd: real('cost_usd').notNull().default(0),
    createdAt: text('created_at').notNull(),
    activityAt: text('activity_at').notNull().default(''),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [index('idx_sessions_project').on(table.projectId)]
);

export const sessionMembers = sqliteTable(
  'session_members',
  {
    sessionId: text('session_id').notNull(),
    memberId: text('member_id').notNull(),
    templateId: text('template_id'),
    type: text('type').notNull(),
    meshSessionId: text('mesh_session_id'),
    data: text('data').notNull().default('{}'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.memberId] }),
    index('idx_session_members_session').on(table.sessionId)
  ]
);

export const workplaceProjects = sqliteTable(
  'workplace_projects',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    state: text('state').notNull(),
    archived: integer('archived').notNull().default(0),
    model: text('model'),
    cwd: text('cwd'),
    origin: text('origin'),
    memberTemplates: text('member_templates').notNull().default('[]'),
    autoInviteProjectMembers: integer('auto_invite_project_members').notNull().default(1),
    sortRank: integer('sort_rank').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [index('idx_workplace_projects_state').on(table.state, table.archived)]
);

export const projectMembers = sqliteTable(
  'project_members',
  {
    projectId: text('project_id').notNull(),
    id: text('id').notNull(),
    profileId: text('profile_id').notNull(),
    type: text('type').notNull(),
    displayName: text('display_name').notNull(),
    customPrompt: text('custom_prompt'),
    launchOverrides: text('launch_overrides').notNull().default('{}'),
    workingDirectoryOverride: text('working_directory_override'),
    lifecycle: text('lifecycle').notNull().default('enabled'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.id] }),
    index('idx_project_members_project_lifecycle').on(table.projectId, table.lifecycle)
  ]
);

export const sessionBindings = sqliteTable(
  'session_bindings',
  {
    sessionId: text('session_id').notNull(),
    projectMemberId: text('project_member_id').notNull(),
    lastDeliveredSeq: integer('last_delivered_seq').notNull().default(0),
    lastVisibleSeq: integer('last_visible_seq').notNull().default(0),
    currentNativeRuntimeSessionId: text('current_native_runtime_session_id'),
    lifecycle: text('lifecycle').notNull().default('active'),
    lastHealth: text('last_health'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.projectMemberId] }),
    index('idx_session_bindings_member').on(table.projectMemberId, table.sessionId),
    index('idx_session_bindings_runtime').on(table.currentNativeRuntimeSessionId)
  ]
);

export const sessionPlans = sqliteTable('session_plans', {
  sessionId: text('session_id').primaryKey(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
});

export const sessionPlanTodos = sqliteTable(
  'session_plan_todos',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    text: text('text').notNull(),
    status: text('status').notNull(),
    assigneeProjectMemberId: text('assignee_project_member_id'),
    version: integer('version').notNull().default(0),
    createdBy: text('created_by').notNull(),
    updatedBy: text('updated_by').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [index('idx_session_plan_todos_session').on(table.sessionId, table.createdAt, table.id)]
);

export const sessionPlanMutations = sqliteTable(
  'session_plan_mutations',
  {
    sessionId: text('session_id').notNull(),
    requestId: text('request_id').notNull(),
    operation: text('operation').notNull(),
    commandFingerprint: text('command_fingerprint').notNull(),
    result: text('result').notNull(),
    createdAt: text('created_at').notNull()
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.requestId] }),
    index('idx_session_plan_mutations_created').on(table.sessionId, table.createdAt)
  ]
);

export const sessionPlanEvents = sqliteTable(
  'session_plan_events',
  {
    sequence: integer('sequence').primaryKey({ autoIncrement: true }),
    id: text('id').notNull(),
    sessionId: text('session_id').notNull(),
    requestId: text('request_id').notNull(),
    type: text('type').notNull(),
    payload: text('payload').notNull(),
    createdAt: text('created_at').notNull(),
    publishedAt: text('published_at')
  },
  (table) => [
    uniqueIndex('idx_session_plan_events_id').on(table.id),
    uniqueIndex('idx_session_plan_events_request').on(table.sessionId, table.requestId),
    index('idx_session_plan_events_pending').on(table.publishedAt, table.sequence)
  ]
);

export const sessionPlanAuditLog = sqliteTable(
  'session_plan_audit_log',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    requestId: text('request_id').notNull(),
    operation: text('operation').notNull(),
    todoId: text('todo_id'),
    source: text('source').notNull(),
    projectMemberId: text('project_member_id'),
    resourceVersion: integer('resource_version'),
    outcome: text('outcome').notNull(),
    errorCode: text('error_code'),
    createdAt: text('created_at').notNull()
  },
  (table) => [index('idx_session_plan_audit_session').on(table.sessionId, table.createdAt, table.id)]
);

export const workplaceProjectOrder = sqliteTable('workplace_project_order', {
  id: integer('id').primaryKey(),
  revision: integer('revision').notNull().default(0)
});

export const sessionAttentionItems = sqliteTable(
  'session_attention_items',
  {
    itemKey: text('item_key').primaryKey(),
    sessionId: text('session_id').notNull(),
    kind: text('kind').notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id').notNull(),
    occurredAt: text('occurred_at').notNull(),
    createdAt: text('created_at').notNull()
  },
  (table) => [
    index('idx_session_attention_session').on(table.sessionId, table.kind, table.occurredAt),
    index('idx_session_attention_source').on(table.sessionId, table.sourceType, table.sourceId)
  ]
);

export const usageLedger = sqliteTable(
  'usage_ledger',
  {
    day: text('day').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    category: text('category').notNull().default('chat'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    reasoningTokens: integer('reasoning_tokens').notNull().default(0),
    costUsd: real('cost_usd').notNull().default(0),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [primaryKey({ columns: [table.day, table.provider, table.model, table.category] })]
);

export const meshAgentUsageSnapshots = sqliteTable(
  'mesh_agent_usage_snapshots',
  {
    provider: text('provider').notNull(),
    agentName: text('agent_name').notNull(),
    checkedAt: text('checked_at').notNull()
  },
  (table) => [primaryKey({ columns: [table.provider, table.agentName] })]
);

export const meshAgentUsageRecords = sqliteTable(
  'mesh_agent_usage_records',
  {
    provider: text('provider').notNull(),
    agentName: text('agent_name').notNull(),
    name: text('name').notNull(),
    current: real('current').notNull(),
    max: real('max'),
    resetAt: text('reset_at'),
    checkedAt: text('checked_at').notNull()
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.agentName, table.name] }),
    index('idx_mesh_agent_usage_records_provider').on(table.provider, table.agentName)
  ]
);

export const meshSessionUsageSnapshots = sqliteTable(
  'mesh_session_usage_snapshots',
  {
    meshSessionId: text('mesh_session_id').primaryKey(),
    sessionId: text('session_id').notNull(),
    projectId: text('project_id'),
    provider: text('provider').notNull(),
    agentName: text('agent_name').notNull(),
    total: real('total').notNull(),
    input: real('input').notNull(),
    output: real('output').notNull(),
    checkedAt: text('checked_at').notNull()
  },
  (table) => [
    index('idx_mesh_session_usage_project').on(table.projectId),
    index('idx_mesh_session_usage_provider_agent').on(table.provider, table.agentName)
  ]
);

export const experienceState = sqliteTable(
  'experience_state',
  {
    atomPackId: text('atom_pack_id').notNull(),
    projectId: text('project_id').notNull(),
    recordKey: text('record_key').notNull(),
    value: text('value').notNull(),
    version: integer('version').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [
    primaryKey({ columns: [table.atomPackId, table.projectId, table.recordKey] }),
    index('idx_experience_state_project').on(table.atomPackId, table.projectId, table.recordKey)
  ]
);

export const experienceStateEvents = sqliteTable(
  'experience_state_events',
  {
    id: text('id').primaryKey(),
    atomPackId: text('atom_pack_id').notNull(),
    projectId: text('project_id').notNull(),
    recordKey: text('record_key').notNull(),
    version: integer('version').notNull(),
    payload: text('payload').notNull(),
    createdAt: text('created_at').notNull()
  },
  (table) => [
    index('idx_experience_state_events_record').on(table.atomPackId, table.projectId, table.recordKey, table.version)
  ]
);

export const experienceWorkerWakeups = sqliteTable(
  'experience_worker_wakeups',
  {
    atomPackId: text('atom_pack_id').notNull(),
    experienceId: text('experience_id').notNull(),
    projectId: text('project_id').notNull(),
    wakeKey: text('wake_key').notNull(),
    runAt: text('run_at').notNull(),
    attempt: integer('attempt').notNull().default(0),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [
    primaryKey({ columns: [table.atomPackId, table.experienceId, table.projectId, table.wakeKey] }),
    index('idx_experience_worker_wakeups_due').on(table.runAt)
  ]
);

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    transcriptTargetId: text('transcript_target_id').notNull(),
    role: text('role').notNull(),
    text: text('text').notNull(),
    type: text('type').notNull().default('text'),
    data: text('data'),
    replyToMessageId: text('reply_to_message_id'),
    streamStatus: text('stream_status').notNull().default('settled'),
    active: integer('active').notNull().default(1),
    includeInContext: integer('include_in_context'),
    idempotencyKey: text('idempotency_key'),
    commandFingerprint: text('command_fingerprint'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at')
  },
  (table) => [
    index('idx_messages_transcript_target').on(table.transcriptTargetId),
    index('idx_messages_active').on(table.transcriptTargetId, table.active),
    uniqueIndex('idx_messages_target_idempotency').on(table.transcriptTargetId, table.idempotencyKey)
  ]
);

export const transcriptMessageRevisions = sqliteTable('transcript_message_revisions', {
  transcriptTargetId: text('transcript_target_id').primaryKey(),
  revision: integer('revision').notNull().default(0)
});

export const messageMutations = sqliteTable(
  'message_mutations',
  {
    transcriptTargetId: text('transcript_target_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    commandFingerprint: text('command_fingerprint').notNull(),
    messageId: text('message_id').notNull(),
    messageRevision: integer('message_revision').notNull(),
    resultMessage: text('result_message').notNull()
  },
  (table) => [primaryKey({ columns: [table.transcriptTargetId, table.idempotencyKey] })]
);

export const memory = sqliteTable(
  'memory',
  {
    sessionId: text('session_id').notNull(),
    key: text('key').notNull(),
    value: text('value').notNull()
  },
  (table) => [primaryKey({ columns: [table.sessionId, table.key] })]
);

export const fileObservations = sqliteTable(
  'file_observations',
  {
    sessionId: text('session_id').notNull(),
    path: text('path').notNull(),
    hash: text('hash').notNull(),
    coverage: text('coverage').notNull(),
    observedAt: text('observed_at').notNull(),
    toolCallId: text('tool_call_id')
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.path] }),
    index('idx_file_observations_session').on(table.sessionId)
  ]
);

// Full pre-truncation tool outputs, spilled here ONLY when the model-visible result was truncated
// or evicted from context. Keyed by (transcript target, provider tool-call id) so a later handle
// read can page the original bytes instead of re-running the tool — tool calls run in both session
// and workplace-project transcripts, so this follows the messages/events pattern rather than being
// session-only. Cleaned up with the owning session/project. Not stored inline on messages.data to
// keep message reads from dragging blobs.
export const toolRawOutputs = sqliteTable(
  'tool_raw_outputs',
  {
    transcriptTargetId: text('transcript_target_id').notNull(),
    toolCallId: text('tool_call_id').notNull(),
    output: text('output').notNull(),
    createdAt: text('created_at').notNull()
  },
  (table) => [primaryKey({ columns: [table.transcriptTargetId, table.toolCallId] })]
);

export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey(),
    transcriptTargetId: text('transcript_target_id').notNull(),
    type: text('type').notNull(),
    actorAgentId: text('actor_agent_id'),
    taskId: text('task_id'),
    payload: text('payload').notNull(),
    at: text('at').notNull()
  },
  (table) => [index('idx_events_transcript_target').on(table.transcriptTargetId, table.id)]
);

// Per-scope high-watermark for scope-local monotonic event sequences. A scope is a session/project
// transcript target id or the stable daemon scope; the allocator bumps `high_watermark` inside the
// caller's transaction, so a crash cannot regress an already-handed-out sequence and a reopened
// database resumes from the persisted watermark.
export const eventScopeSequence = sqliteTable('event_scope_sequence', {
  scope: text('scope').primaryKey(),
  highWatermark: integer('high_watermark').notNull().default(0)
});

export const channelConversations = sqliteTable(
  'channel_conversations',
  {
    channelId: text('channel_id').notNull(),
    conversationKey: text('conversation_key').notNull(),
    activeSessionId: text('active_session_id').notNull(),
    createdAt: text('created_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull()
  },
  (table) => [primaryKey({ columns: [table.channelId, table.conversationKey] })]
);

export const channelConversationSessions = sqliteTable(
  'channel_conversation_sessions',
  {
    channelId: text('channel_id').notNull(),
    conversationKey: text('conversation_key').notNull(),
    sessionId: text('session_id').notNull(),
    label: text('label'),
    createdAt: text('created_at').notNull()
  },
  (table) => [
    primaryKey({ columns: [table.channelId, table.conversationKey, table.sessionId] }),
    index('idx_channel_conv_sessions_session').on(table.sessionId)
  ]
);

export const messageEmbeddings = sqliteTable('message_embeddings', {
  messageId: text('message_id').primaryKey(),
  dim: integer('dim').notNull(),
  vec: blob('vec').notNull(),
  model: text('model')
});

export const acpDelegates = sqliteTable(
  'acp_delegates',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    agentName: text('agent_name').notNull(),
    acpSessionId: text('acp_session_id').notNull(),
    pid: integer('pid').notNull(),
    spawnedAt: text('spawned_at').notNull(),
    lastUsedAt: text('last_used_at').notNull(),
    evictedAt: text('evicted_at'),
    evictReason: text('evict_reason'),
    reuseCount: integer('reuse_count').notNull().default(0),
    promptCount: integer('prompt_count').notNull().default(0)
  },
  (table) => [
    index('idx_acp_delegates_session').on(table.sessionId),
    index('idx_acp_delegates_live').on(table.evictedAt).where(liveAcpDelegate)
  ]
);

export const meshSessions = sqliteTable(
  'mesh_sessions',
  {
    id: text('id').primaryKey(),
    transcriptTargetId: text('transcript_target_id').notNull(),
    agentName: text('agent_name').notNull(),
    provider: text('provider').notNull(),
    workingPath: text('working_path').notNull(),
    runtimeRole: text('runtime_role').notNull().default('interactive'),
    agentRuntimeId: text('agent_runtime_id'),
    agentRuntimeTokenHash: text('agent_runtime_token_hash'),
    projectMemberId: text('project_member_id'),
    lastDeliveredSeq: integer('last_delivered_seq').notNull().default(0),
    lastVisibleSeq: integer('last_visible_seq').notNull().default(0),
    state: text('state').notNull(),
    pid: integer('pid'),
    providerSessionRef: text('provider_session_ref'),
    exitCode: integer('exit_code'),
    startedAt: text('started_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    exitedAt: text('exited_at')
  },
  (table) => [
    index('idx_mesh_sessions_transcript_target').on(table.transcriptTargetId),
    index('idx_mesh_sessions_live').on(table.state).where(liveMeshSession),
    uniqueIndex('idx_mesh_sessions_provider_ref')
      .on(table.transcriptTargetId, table.provider, table.providerSessionRef)
      .where(providerSessionRefNotNull)
  ]
);

export const messageAttachments = sqliteTable(
  'message_attachments',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    path: text('path').notNull(),
    name: text('name').notNull(),
    mime: text('mime').notNull(),
    bytes: integer('bytes').notNull(),
    preview: text('preview').notNull(),
    createdBy: text('created_by'),
    createdAt: text('created_at').notNull()
  },
  (table) => [index('idx_message_attachments_session').on(table.sessionId)]
);

export const nativeAgentDirectMessages = sqliteTable(
  'native_agent_direct_messages',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    meshSessionId: text('mesh_session_id').notNull(),
    fromAgent: text('from_agent'),
    peer: text('peer').notNull(),
    text: text('text').notNull(),
    attachmentIds: text('attachment_ids'),
    requestId: text('request_id'),
    requestFingerprint: text('request_fingerprint'),
    createdAt: text('created_at').notNull()
  },
  (table) => [
    index('idx_native_agent_direct_messages_session_peer').on(table.meshSessionId, table.peer, table.createdAt),
    index('idx_native_agent_direct_messages_session_pair').on(
      table.sessionId,
      table.fromAgent,
      table.peer,
      table.createdAt
    ),
    uniqueIndex('idx_native_agent_direct_messages_request')
      .on(table.meshSessionId, table.requestId)
      .where(directMessageRequestIdNotNull)
  ]
);

export const meshAgentInboxItems = sqliteTable(
  'mesh_agent_inbox_items',
  {
    meshSessionId: text('mesh_session_id').notNull(),
    messageSeq: integer('message_seq').notNull(),
    deliveryId: text('delivery_id'),
    projectId: text('project_id'),
    memberInstanceId: text('member_instance_id'),
    triggerMessageId: text('trigger_message_id'),
    providerSessionRef: text('provider_session_ref'),
    providerTurnId: text('provider_turn_id'),
    errorSummary: text('error_summary'),
    state: text('state').notNull().default('queued'),
    createdAt: text('created_at').notNull(),
    deliveredAt: text('delivered_at'),
    visibleAt: text('visible_at'),
    consumedAt: text('consumed_at'),
    updatedAt: text('updated_at')
  },
  (table) => [
    primaryKey({ columns: [table.meshSessionId, table.messageSeq] }),
    index('idx_mesh_agent_inbox_items_pending').on(table.meshSessionId, table.state, table.messageSeq),
    uniqueIndex('idx_mesh_agent_inbox_delivery_id').on(table.deliveryId).where(deliveryIdNotNull),
    index('idx_mesh_agent_inbox_project_trigger').on(table.projectId, table.triggerMessageId),
    index('idx_mesh_agent_inbox_member_state').on(table.projectId, table.memberInstanceId, table.state)
  ]
);

export const meshAgentIngressCounters = sqliteTable(
  'mesh_agent_ingress_counters',
  {
    projectId: text('project_id').notNull(),
    memberInstanceId: text('member_instance_id').notNull(),
    nextSeq: integer('next_seq').notNull().default(1),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [primaryKey({ columns: [table.projectId, table.memberInstanceId] })]
);

export const nativeAgentIngressItems = sqliteTable(
  'native_agent_ingress_items',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    memberInstanceId: text('member_instance_id').notNull(),
    meshSessionId: text('mesh_session_id'),
    ingressSeq: integer('ingress_seq').notNull(),
    sourceKind: text('source_kind').notNull(),
    messageSeq: integer('message_seq'),
    messageId: text('message_id'),
    directMessageId: text('direct_message_id'),
    deliveryId: text('delivery_id'),
    state: text('state').notNull().default('queued'),
    claimBatchId: text('claim_batch_id'),
    providerSessionRef: text('provider_session_ref'),
    providerTurnId: text('provider_turn_id'),
    errorSummary: text('error_summary'),
    createdAt: text('created_at').notNull(),
    deliveredAt: text('delivered_at'),
    visibleAt: text('visible_at'),
    consumedAt: text('consumed_at'),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [
    uniqueIndex('idx_native_agent_ingress_member_seq').on(table.projectId, table.memberInstanceId, table.ingressSeq),
    index('idx_native_agent_ingress_member_state').on(
      table.projectId,
      table.memberInstanceId,
      table.state,
      table.ingressSeq
    ),
    uniqueIndex('idx_native_agent_ingress_message')
      .on(table.projectId, table.memberInstanceId, table.messageId)
      .where(ingressMessageIdNotNull),
    uniqueIndex('idx_native_agent_ingress_direct').on(table.directMessageId).where(ingressDirectMessageIdNotNull),
    uniqueIndex('idx_native_agent_ingress_delivery').on(table.deliveryId).where(deliveryIdNotNull),
    index('idx_native_agent_ingress_claim').on(table.claimBatchId, table.ingressSeq)
  ]
);

export const nativeAgentAsks = sqliteTable(
  'native_agent_asks',
  {
    requestId: text('request_id').primaryKey(),
    projectId: text('project_id').notNull(),
    projectSessionId: text('project_session_id').notNull(),
    memberInstanceId: text('member_instance_id').notNull(),
    meshSessionId: text('mesh_session_id'),
    blocking: integer('blocking', { mode: 'boolean' }).notNull().default(false),
    state: text('state').notNull(),
    outcome: text('outcome'),
    answers: text('answers'),
    expiresAt: text('expires_at'),
    createdAt: text('created_at').notNull(),
    resolvedAt: text('resolved_at'),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [
    uniqueIndex('idx_native_agent_asks_unresolved_member')
      .on(table.projectSessionId, table.memberInstanceId)
      .where(unresolvedNativeAgentAsk),
    index('idx_native_agent_asks_state_expiry').on(table.state, table.expiresAt)
  ]
);

export const nativeAgentAskQuestions = sqliteTable(
  'native_agent_ask_questions',
  {
    requestId: text('request_id').notNull(),
    questionId: text('question_id').notNull(),
    position: integer('position').notNull(),
    question: text('question').notNull(),
    options: text('options').notNull().default('[]'),
    mode: text('mode').notNull().default('single'),
    allowOther: integer('allow_other', { mode: 'boolean' }).notNull().default(true)
  },
  (table) => [
    primaryKey({ columns: [table.requestId, table.questionId] }),
    uniqueIndex('idx_native_agent_ask_questions_position').on(table.requestId, table.position)
  ]
);

export const nativeAgentMemberGates = sqliteTable(
  'native_agent_member_gates',
  {
    projectId: text('project_id').notNull(),
    projectSessionId: text('project_session_id').notNull(),
    memberInstanceId: text('member_instance_id').notNull(),
    requestId: text('request_id').notNull(),
    state: text('state').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [
    primaryKey({ columns: [table.projectSessionId, table.memberInstanceId] }),
    uniqueIndex('idx_native_agent_member_gates_request').on(table.requestId)
  ]
);

export const nativeAgentRecoveryBatches = sqliteTable(
  'native_agent_recovery_batches',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    memberInstanceId: text('member_instance_id').notNull(),
    askRequestId: text('ask_request_id'),
    highWaterSeq: integer('high_water_seq').notNull(),
    state: text('state').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [index('idx_native_agent_recovery_member_state').on(table.projectId, table.memberInstanceId, table.state)]
);

// Durable delivery-ledger rows whose legacy `member_instance_id` (an agentName alias) could not be
// resolved to a single canonical projectMemberId during boot reconciliation — 0 candidates (no owning
// runtime) or ≥2 (ambiguous alias reuse). The row is kept keyed on its legacy value and left inert
// (never current-ized/consumed) until identity becomes resolvable; the boot reconciler upserts this by a
// deterministic `id` so a re-run over the same unresolved state mutates nothing.
export const nativeAgentReconcileFailures = sqliteTable(
  'native_agent_reconcile_failures',
  {
    id: text('id').primaryKey(),
    sourceTable: text('source_table').notNull(),
    projectId: text('project_id'),
    sessionId: text('session_id'),
    legacyMemberKey: text('legacy_member_key').notNull(),
    candidateCount: integer('candidate_count').notNull(),
    reason: text('reason').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [index('idx_native_agent_reconcile_failures_source').on(table.sourceTable, table.projectId)]
);

export const inboxItemReads = sqliteTable('inbox_item_reads', {
  itemKey: text('item_key').primaryKey(),
  readAt: text('read_at').notNull()
});
