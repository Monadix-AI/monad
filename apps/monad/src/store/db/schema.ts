import { sql } from 'drizzle-orm';
// biome-ignore lint/suspicious/noDeprecatedImports: drizzle marks the named export deprecated but the object-form API we use is correct
import { integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  projectId: text('project_id'), // null = plain chat session; set = a session under this project (Track B)
  title: text('title').notNull(),
  ownerPrincipalId: text('owner_principal_id').notNull(),
  state: text('state').notNull(),
  agentIds: text('agent_ids').notNull().default('[]'),
  parentSessionId: text('parent_session_id'),
  branchedAtMessageId: text('branched_at_message_id'),
  archived: integer('archived').notNull().default(0),
  restoreCount: integer('restore_count').notNull().default(0),
  model: text('model'), // per-session model-profile alias override (null → daemon default)
  cwd: text('cwd'), // default working dir for shell commands + skill-path matching; null → daemon workspace
  origin: text('origin'), // JSON SessionOrigin (provenance + write policy + env); null when no origin was built
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  totalTokens: integer('total_tokens').notNull().default(0),
  cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
  cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
  reasoningTokens: integer('reasoning_tokens').notNull().default(0),
  costUsd: real('cost_usd').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
});

export const workplaceProjects = sqliteTable('workplace_projects', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  ownerPrincipalId: text('owner_principal_id').notNull(),
  state: text('state').notNull(),
  archived: integer('archived').notNull().default(0),
  model: text('model'),
  cwd: text('cwd'),
  origin: text('origin'),
  memberTemplates: text('member_templates').notNull().default('[]'), // JSON WorkplaceProjectMemberTemplate[] — presets a session can invite from (Track B)
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
});

// A session's live member bindings (Track B). workplace_projects.memberTemplates are presets;
// a row here is the actual per-session binding — invited from a template (templateId set) or spawned
// ad hoc (null). Each session's binding runs its own external-agent session, never shared across
// sessions even when invited from the same template.
export const sessionMembers = sqliteTable(
  'session_members',
  {
    sessionId: text('session_id').notNull(),
    memberId: text('member_id').notNull(),
    templateId: text('template_id'),
    type: text('type').notNull(),
    externalAgentSessionId: text('external_agent_session_id'),
    data: text('data').notNull().default('{}'), // JSON: name, templateName, displayName, settings, ...
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.memberId] })]
);

// Global, append-only usage accounting — the "账本". Bucketed by (local day, provider, model,
// category), monotonic, survives session deletion; only a manual clearLedger() resets it. Distinct
// from per-session usage (which is cleared when a session is reset).
const _usageLedger = sqliteTable(
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
  (t) => [primaryKey({ columns: [t.day, t.provider, t.model, t.category] })]
);

const providerSessionRefNotNull = sql`provider_session_ref IS NOT NULL`;

export const tasks = sqliteTable('tasks', {
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
});

const _externalAgentSessions = sqliteTable(
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
  (t) => [
    uniqueIndex('idx_external_agent_sessions_provider_ref')
      .on(t.transcriptTargetId, t.provider, t.providerSessionRef)
      .where(providerSessionRefNotNull)
  ]
);

const _nativeAgentDirectMessages = sqliteTable('native_agent_direct_messages', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  externalAgentSessionId: text('external_agent_session_id').notNull(),
  fromAgent: text('from_agent'),
  peer: text('peer').notNull(),
  text: text('text').notNull(),
  attachmentIds: text('attachment_ids'), // JSON string[] of message_attachments ids
  createdAt: text('created_at').notNull()
});

const _messageAttachments = sqliteTable('message_attachments', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  path: text('path').notNull(),
  name: text('name').notNull(),
  mime: text('mime').notNull(),
  bytes: integer('bytes').notNull(),
  preview: text('preview').notNull(),
  createdBy: text('created_by'),
  createdAt: text('created_at').notNull()
});

const _externalAgentInboxItems = sqliteTable(
  'external_agent_inbox_items',
  {
    externalAgentSessionId: text('external_agent_session_id').notNull(),
    messageSeq: integer('message_seq').notNull(),
    state: text('state').notNull().default('queued'),
    createdAt: text('created_at').notNull(),
    deliveredAt: text('delivered_at'),
    visibleAt: text('visible_at'),
    consumedAt: text('consumed_at')
  },
  (t) => [primaryKey({ columns: [t.externalAgentSessionId, t.messageSeq] })]
);

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  transcriptTargetId: text('transcript_target_id').notNull(),
  role: text('role').notNull(),
  text: text('text').notNull(),
  type: text('type').notNull().default('text'),
  data: text('data'),
  streamStatus: text('stream_status').notNull().default('settled'),
  active: integer('active').notNull().default(1),
  includeInContext: integer('include_in_context'), // NULL ⇒ use the type's registry default
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at')
});

const _memory = sqliteTable('memory', {
  sessionId: text('session_id').notNull(),
  key: text('key').notNull(),
  value: text('value').notNull()
});

const _fileObservations = sqliteTable(
  'file_observations',
  {
    sessionId: text('session_id').notNull(),
    path: text('path').notNull(),
    hash: text('hash').notNull(),
    coverage: text('coverage').notNull(),
    observedAt: text('observed_at').notNull(),
    toolCallId: text('tool_call_id')
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.path] })]
);

const _channelConversations = sqliteTable('channel_conversations', {
  channelId: text('channel_id').notNull(),
  conversationKey: text('conversation_key').notNull(),
  activeSessionId: text('active_session_id').notNull(),
  principalId: text('principal_id').notNull(),
  createdAt: text('created_at').notNull(),
  lastSeenAt: text('last_seen_at').notNull()
});

const _channelConversationSessions = sqliteTable('channel_conversation_sessions', {
  channelId: text('channel_id').notNull(),
  conversationKey: text('conversation_key').notNull(),
  sessionId: text('session_id').notNull(),
  label: text('label'),
  createdAt: text('created_at').notNull()
});

// Event ids are random branded nanoids; durable replay order comes from SQLite rowid.
const _events = sqliteTable('events', {
  id: text('id').primaryKey(),
  transcriptTargetId: text('transcript_target_id').notNull(),
  type: text('type').notNull(),
  actorAgentId: text('actor_agent_id'),
  taskId: text('task_id'),
  payload: text('payload').notNull(),
  at: text('at').notNull()
});
