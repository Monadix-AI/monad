import { sql } from 'drizzle-orm';
// biome-ignore lint/suspicious/noDeprecatedImports: drizzle marks the named export deprecated but the object-form API we use is correct
import { blob, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const providerSessionRefNotNull = sql`provider_session_ref IS NOT NULL`;
const liveExternalAgentSession = sql`state IN ('starting', 'running')`;
const liveAcpDelegate = sql`evicted_at IS NULL`;
const deliveryIdNotNull = sql`delivery_id IS NOT NULL`;

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
    externalAgentSessionId: text('external_agent_session_id'),
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
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [index('idx_workplace_projects_state').on(table.state, table.archived)]
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

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    title: text('title').notNull(),
    assigneeAgentId: text('assignee_agent_id'),
    dependsOn: text('depends_on').notNull().default('[]'),
    state: text('state').notNull(),
    version: integer('version').notNull().default(0),
    result: text('result'),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [index('idx_tasks_session').on(table.sessionId)]
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
    streamStatus: text('stream_status').notNull().default('settled'),
    active: integer('active').notNull().default(1),
    includeInContext: integer('include_in_context'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at')
  },
  (table) => [
    index('idx_messages_transcript_target').on(table.transcriptTargetId),
    index('idx_messages_active').on(table.transcriptTargetId, table.active)
  ]
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

export const externalAgentSessions = sqliteTable(
  'external_agent_sessions',
  {
    id: text('id').primaryKey(),
    transcriptTargetId: text('transcript_target_id').notNull(),
    agentName: text('agent_name').notNull(),
    provider: text('provider').notNull(),
    workingPath: text('working_path').notNull(),
    launchMode: text('launch_mode').notNull(),
    runtimeRole: text('runtime_role').notNull().default('interactive'),
    agentRuntimeId: text('agent_runtime_id'),
    agentRuntimeTokenHash: text('agent_runtime_token_hash'),
    lastDeliveredSeq: integer('last_delivered_seq').notNull().default(0),
    lastVisibleSeq: integer('last_visible_seq').notNull().default(0),
    state: text('state').notNull(),
    pid: integer('pid'),
    providerSessionRef: text('provider_session_ref'),
    outputSnapshot: text('output_snapshot').notNull().default(''),
    exitCode: integer('exit_code'),
    startedAt: text('started_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    exitedAt: text('exited_at')
  },
  (table) => [
    index('idx_external_agent_sessions_transcript_target').on(table.transcriptTargetId),
    index('idx_external_agent_sessions_live').on(table.state).where(liveExternalAgentSession),
    uniqueIndex('idx_external_agent_sessions_provider_ref')
      .on(table.transcriptTargetId, table.provider, table.providerSessionRef)
      .where(providerSessionRefNotNull)
  ]
);

export const externalAgentObservationEvents = sqliteTable(
  'external_agent_observation_events',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    externalAgentSessionId: text('external_agent_session_id')
      .notNull()
      .references(() => externalAgentSessions.id, { onDelete: 'cascade' }),
    dedupeKey: text('dedupe_key').notNull(),
    eventJson: text('event_json').notNull(),
    observedAt: text('observed_at').notNull()
  },
  (table) => [
    uniqueIndex('idx_external_agent_observation_dedupe').on(table.externalAgentSessionId, table.dedupeKey),
    index('idx_external_agent_observation_page').on(table.externalAgentSessionId, table.seq)
  ]
);

export const messageAttachments = sqliteTable(
  'message_attachments',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    path: text('path').notNull(),
    name: text('name').notNull(),
    mime: text('mime').notNull(),
    bytes: integer('bytes').notNull(),
    preview: text('preview').notNull(),
    createdBy: text('created_by'),
    createdAt: text('created_at').notNull()
  },
  (table) => [index('idx_message_attachments_project').on(table.projectId)]
);

export const nativeAgentDirectMessages = sqliteTable(
  'native_agent_direct_messages',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    externalAgentSessionId: text('external_agent_session_id').notNull(),
    fromAgent: text('from_agent'),
    peer: text('peer').notNull(),
    text: text('text').notNull(),
    attachmentIds: text('attachment_ids'),
    createdAt: text('created_at').notNull()
  },
  (table) => [
    index('idx_native_agent_direct_messages_session_peer').on(
      table.externalAgentSessionId,
      table.peer,
      table.createdAt
    ),
    index('idx_native_agent_direct_messages_project_pair').on(
      table.projectId,
      table.fromAgent,
      table.peer,
      table.createdAt
    )
  ]
);

export const externalAgentInboxItems = sqliteTable(
  'external_agent_inbox_items',
  {
    externalAgentSessionId: text('external_agent_session_id').notNull(),
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
    primaryKey({ columns: [table.externalAgentSessionId, table.messageSeq] }),
    index('idx_external_agent_inbox_items_pending').on(table.externalAgentSessionId, table.state, table.messageSeq),
    uniqueIndex('idx_external_agent_inbox_delivery_id').on(table.deliveryId).where(deliveryIdNotNull),
    index('idx_external_agent_inbox_project_trigger').on(table.projectId, table.triggerMessageId),
    index('idx_external_agent_inbox_member_state').on(table.projectId, table.memberInstanceId, table.state)
  ]
);
