import { sql } from 'drizzle-orm';
// biome-ignore lint/suspicious/noDeprecatedImports: drizzle marks the named export deprecated but the object-form API we use is correct
import { integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
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
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
});

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

const _nativeCliSessions = sqliteTable(
  'native_cli_sessions',
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
    uniqueIndex('idx_native_cli_sessions_provider_ref')
      .on(t.transcriptTargetId, t.provider, t.providerSessionRef)
      .where(providerSessionRefNotNull)
  ]
);

const _nativeAgentDirectMessages = sqliteTable('native_agent_direct_messages', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  nativeCliSessionId: text('native_cli_session_id').notNull(),
  fromAgent: text('from_agent'),
  peer: text('peer').notNull(),
  text: text('text').notNull(),
  createdAt: text('created_at').notNull()
});

const _nativeCliInboxItems = sqliteTable(
  'native_cli_inbox_items',
  {
    nativeCliSessionId: text('native_cli_session_id').notNull(),
    messageSeq: integer('message_seq').notNull(),
    state: text('state').notNull().default('queued'),
    createdAt: text('created_at').notNull(),
    deliveredAt: text('delivered_at'),
    visibleAt: text('visible_at'),
    consumedAt: text('consumed_at')
  },
  (t) => [primaryKey({ columns: [t.nativeCliSessionId, t.messageSeq] })]
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

const _channelModeratorRounds = sqliteTable('channel_moderator_rounds', {
  id: text('id').primaryKey(),
  channelId: text('channel_id').notNull(),
  moderatorKey: text('moderator_key').notNull(),
  moderatorAgentId: text('moderator_agent_id').notNull(),
  originalInbound: text('original_inbound').notNull(),
  depth: integer('depth').notNull(),
  tasks: text('tasks').notNull(),
  results: text('results').notNull().default('[]'),
  status: text('status').notNull(),
  deadlineAt: text('deadline_at').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
});

// `id` is a sortable evt_ ULID so ordering/resume-after-cursor is a string compare.
const _events = sqliteTable('events', {
  id: text('id').primaryKey(),
  transcriptTargetId: text('transcript_target_id').notNull(),
  type: text('type').notNull(),
  actorAgentId: text('actor_agent_id'),
  taskId: text('task_id'),
  payload: text('payload').notNull(),
  at: text('at').notNull()
});
