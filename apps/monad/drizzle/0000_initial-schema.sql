CREATE TABLE `acp_delegates` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`agent_name` text NOT NULL,
	`acp_session_id` text NOT NULL,
	`pid` integer NOT NULL,
	`spawned_at` text NOT NULL,
	`last_used_at` text NOT NULL,
	`evicted_at` text,
	`evict_reason` text,
	`reuse_count` integer DEFAULT 0 NOT NULL,
	`prompt_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_acp_delegates_session` ON `acp_delegates` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_acp_delegates_live` ON `acp_delegates` (`evicted_at`) WHERE evicted_at IS NULL;--> statement-breakpoint
CREATE TABLE `channel_conversation_sessions` (
	`channel_id` text NOT NULL,
	`conversation_key` text NOT NULL,
	`session_id` text NOT NULL,
	`label` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`channel_id`, `conversation_key`, `session_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_channel_conv_sessions_session` ON `channel_conversation_sessions` (`session_id`);--> statement-breakpoint
CREATE TABLE `channel_conversations` (
	`channel_id` text NOT NULL,
	`conversation_key` text NOT NULL,
	`active_session_id` text NOT NULL,
	`created_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	PRIMARY KEY(`channel_id`, `conversation_key`)
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`transcript_target_id` text NOT NULL,
	`type` text NOT NULL,
	`actor_agent_id` text,
	`task_id` text,
	`payload` text NOT NULL,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_events_transcript_target` ON `events` (`transcript_target_id`,`id`);--> statement-breakpoint
CREATE TABLE `experience_state` (
	`atom_pack_id` text NOT NULL,
	`project_id` text NOT NULL,
	`record_key` text NOT NULL,
	`value` text NOT NULL,
	`version` integer NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`atom_pack_id`, `project_id`, `record_key`)
);
--> statement-breakpoint
CREATE INDEX `idx_experience_state_project` ON `experience_state` (`atom_pack_id`,`project_id`,`record_key`);--> statement-breakpoint
CREATE TABLE `experience_state_events` (
	`id` text PRIMARY KEY NOT NULL,
	`atom_pack_id` text NOT NULL,
	`project_id` text NOT NULL,
	`record_key` text NOT NULL,
	`version` integer NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_experience_state_events_record` ON `experience_state_events` (`atom_pack_id`,`project_id`,`record_key`,`version`);--> statement-breakpoint
CREATE TABLE `experience_worker_wakeups` (
	`atom_pack_id` text NOT NULL,
	`experience_id` text NOT NULL,
	`project_id` text NOT NULL,
	`wake_key` text NOT NULL,
	`run_at` text NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`atom_pack_id`, `experience_id`, `project_id`, `wake_key`)
);
--> statement-breakpoint
CREATE INDEX `idx_experience_worker_wakeups_due` ON `experience_worker_wakeups` (`run_at`);--> statement-breakpoint
CREATE TABLE `external_agent_inbox_items` (
	`external_agent_session_id` text NOT NULL,
	`message_seq` integer NOT NULL,
	`delivery_id` text,
	`project_id` text,
	`member_instance_id` text,
	`trigger_message_id` text,
	`provider_session_ref` text,
	`provider_turn_id` text,
	`error_summary` text,
	`state` text DEFAULT 'queued' NOT NULL,
	`created_at` text NOT NULL,
	`delivered_at` text,
	`visible_at` text,
	`consumed_at` text,
	`updated_at` text,
	PRIMARY KEY(`external_agent_session_id`, `message_seq`)
);
--> statement-breakpoint
CREATE INDEX `idx_external_agent_inbox_items_pending` ON `external_agent_inbox_items` (`external_agent_session_id`,`state`,`message_seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_external_agent_inbox_delivery_id` ON `external_agent_inbox_items` (`delivery_id`) WHERE delivery_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_external_agent_inbox_project_trigger` ON `external_agent_inbox_items` (`project_id`,`trigger_message_id`);--> statement-breakpoint
CREATE INDEX `idx_external_agent_inbox_member_state` ON `external_agent_inbox_items` (`project_id`,`member_instance_id`,`state`);--> statement-breakpoint
CREATE TABLE `external_agent_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`transcript_target_id` text NOT NULL,
	`agent_name` text NOT NULL,
	`provider` text NOT NULL,
	`working_path` text NOT NULL,
	`launch_mode` text NOT NULL,
	`runtime_role` text DEFAULT 'interactive' NOT NULL,
	`agent_runtime_id` text,
	`agent_runtime_token_hash` text,
	`last_delivered_seq` integer DEFAULT 0 NOT NULL,
	`last_visible_seq` integer DEFAULT 0 NOT NULL,
	`state` text NOT NULL,
	`pid` integer,
	`provider_session_ref` text,
	`output_snapshot` text DEFAULT '' NOT NULL,
	`exit_code` integer,
	`started_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`exited_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_external_agent_sessions_transcript_target` ON `external_agent_sessions` (`transcript_target_id`);--> statement-breakpoint
CREATE INDEX `idx_external_agent_sessions_live` ON `external_agent_sessions` (`state`) WHERE state IN ('starting', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX `idx_external_agent_sessions_provider_ref` ON `external_agent_sessions` (`transcript_target_id`,`provider`,`provider_session_ref`) WHERE provider_session_ref IS NOT NULL;--> statement-breakpoint
CREATE TABLE `file_observations` (
	`session_id` text NOT NULL,
	`path` text NOT NULL,
	`hash` text NOT NULL,
	`coverage` text NOT NULL,
	`observed_at` text NOT NULL,
	`tool_call_id` text,
	PRIMARY KEY(`session_id`, `path`)
);
--> statement-breakpoint
CREATE INDEX `idx_file_observations_session` ON `file_observations` (`session_id`);--> statement-breakpoint
CREATE TABLE `memory` (
	`session_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`session_id`, `key`)
);
--> statement-breakpoint
CREATE TABLE `message_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`path` text NOT NULL,
	`name` text NOT NULL,
	`mime` text NOT NULL,
	`bytes` integer NOT NULL,
	`preview` text NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_message_attachments_project` ON `message_attachments` (`project_id`);--> statement-breakpoint
CREATE TABLE `message_embeddings` (
	`message_id` text PRIMARY KEY NOT NULL,
	`dim` integer NOT NULL,
	`vec` blob NOT NULL,
	`model` text
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`transcript_target_id` text NOT NULL,
	`role` text NOT NULL,
	`text` text NOT NULL,
	`type` text DEFAULT 'text' NOT NULL,
	`data` text,
	`stream_status` text DEFAULT 'settled' NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`include_in_context` integer,
	`created_at` text NOT NULL,
	`updated_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_messages_transcript_target` ON `messages` (`transcript_target_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_active` ON `messages` (`transcript_target_id`,`active`);--> statement-breakpoint
CREATE TABLE `native_agent_direct_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`external_agent_session_id` text NOT NULL,
	`from_agent` text,
	`peer` text NOT NULL,
	`text` text NOT NULL,
	`attachment_ids` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_native_agent_direct_messages_session_peer` ON `native_agent_direct_messages` (`external_agent_session_id`,`peer`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_native_agent_direct_messages_project_pair` ON `native_agent_direct_messages` (`project_id`,`from_agent`,`peer`,`created_at`);--> statement-breakpoint
CREATE TABLE `session_members` (
	`session_id` text NOT NULL,
	`member_id` text NOT NULL,
	`template_id` text,
	`type` text NOT NULL,
	`external_agent_session_id` text,
	`data` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`session_id`, `member_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_session_members_session` ON `session_members` (`session_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`title` text NOT NULL,
	`state` text NOT NULL,
	`agent_ids` text DEFAULT '[]' NOT NULL,
	`archived` integer DEFAULT 0 NOT NULL,
	`restore_count` integer DEFAULT 0 NOT NULL,
	`model` text,
	`cwd` text,
	`origin` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`reasoning_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_project` ON `sessions` (`project_id`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`title` text NOT NULL,
	`assignee_agent_id` text,
	`depends_on` text DEFAULT '[]' NOT NULL,
	`state` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`result` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_tasks_session` ON `tasks` (`session_id`);--> statement-breakpoint
CREATE TABLE `usage_ledger` (
	`day` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`category` text DEFAULT 'chat' NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`reasoning_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`day`, `provider`, `model`, `category`)
);
--> statement-breakpoint
CREATE TABLE `workplace_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`state` text NOT NULL,
	`archived` integer DEFAULT 0 NOT NULL,
	`model` text,
	`cwd` text,
	`origin` text,
	`member_templates` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_workplace_projects_state` ON `workplace_projects` (`state`,`archived`);
--> statement-breakpoint
CREATE TABLE `tool_raw_outputs` (
	`transcript_target_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`output` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`transcript_target_id`, `tool_call_id`)
);
