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
CREATE TABLE `event_scope_sequence` (
	`scope` text PRIMARY KEY NOT NULL,
	`high_watermark` integer DEFAULT 0 NOT NULL
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
CREATE TABLE `inbox_item_reads` (
	`item_key` text PRIMARY KEY NOT NULL,
	`read_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memory` (
	`session_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`session_id`, `key`)
);
--> statement-breakpoint
CREATE TABLE `mesh_agent_inbox_items` (
	`mesh_session_id` text NOT NULL,
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
	PRIMARY KEY(`mesh_session_id`, `message_seq`)
);
--> statement-breakpoint
CREATE INDEX `idx_mesh_agent_inbox_items_pending` ON `mesh_agent_inbox_items` (`mesh_session_id`,`state`,`message_seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_mesh_agent_inbox_delivery_id` ON `mesh_agent_inbox_items` (`delivery_id`) WHERE delivery_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_mesh_agent_inbox_project_trigger` ON `mesh_agent_inbox_items` (`project_id`,`trigger_message_id`);--> statement-breakpoint
CREATE INDEX `idx_mesh_agent_inbox_member_state` ON `mesh_agent_inbox_items` (`project_id`,`member_instance_id`,`state`);--> statement-breakpoint
CREATE TABLE `mesh_agent_ingress_counters` (
	`project_id` text NOT NULL,
	`member_instance_id` text NOT NULL,
	`next_seq` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`project_id`, `member_instance_id`)
);
--> statement-breakpoint
CREATE TABLE `mesh_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`transcript_target_id` text NOT NULL,
	`agent_name` text NOT NULL,
	`provider` text NOT NULL,
	`working_path` text NOT NULL,
	`runtime_role` text DEFAULT 'interactive' NOT NULL,
	`agent_runtime_id` text,
	`agent_runtime_token_hash` text,
	`project_member_id` text,
	`last_delivered_seq` integer DEFAULT 0 NOT NULL,
	`last_visible_seq` integer DEFAULT 0 NOT NULL,
	`state` text NOT NULL,
	`pid` integer,
	`provider_session_ref` text,
	`exit_code` integer,
	`started_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`exited_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_mesh_sessions_transcript_target` ON `mesh_sessions` (`transcript_target_id`);--> statement-breakpoint
CREATE INDEX `idx_mesh_sessions_live` ON `mesh_sessions` (`state`) WHERE state IN ('starting', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX `idx_mesh_sessions_provider_ref` ON `mesh_sessions` (`transcript_target_id`,`provider`,`provider_session_ref`) WHERE provider_session_ref IS NOT NULL;--> statement-breakpoint
CREATE TABLE `message_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`path` text NOT NULL,
	`name` text NOT NULL,
	`mime` text NOT NULL,
	`bytes` integer NOT NULL,
	`preview` text NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_message_attachments_session` ON `message_attachments` (`session_id`);--> statement-breakpoint
CREATE TABLE `message_embeddings` (
	`message_id` text PRIMARY KEY NOT NULL,
	`dim` integer NOT NULL,
	`vec` blob NOT NULL,
	`model` text
);
--> statement-breakpoint
CREATE TABLE `message_mutations` (
	`transcript_target_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`command_fingerprint` text NOT NULL,
	`message_id` text NOT NULL,
	`message_revision` integer NOT NULL,
	`result_message` text NOT NULL,
	PRIMARY KEY(`transcript_target_id`, `idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`transcript_target_id` text NOT NULL,
	`role` text NOT NULL,
	`text` text NOT NULL,
	`type` text DEFAULT 'text' NOT NULL,
	`data` text,
	`reply_to_message_id` text,
	`stream_status` text DEFAULT 'settled' NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`include_in_context` integer,
	`idempotency_key` text,
	`command_fingerprint` text,
	`created_at` text NOT NULL,
	`updated_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_messages_transcript_target` ON `messages` (`transcript_target_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_active` ON `messages` (`transcript_target_id`,`active`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_messages_target_idempotency` ON `messages` (`transcript_target_id`,`idempotency_key`);--> statement-breakpoint
CREATE TABLE `native_agent_ask_questions` (
	`request_id` text NOT NULL,
	`question_id` text NOT NULL,
	`position` integer NOT NULL,
	`question` text NOT NULL,
	`options` text DEFAULT '[]' NOT NULL,
	`mode` text DEFAULT 'single' NOT NULL,
	`allow_other` integer DEFAULT true NOT NULL,
	PRIMARY KEY(`request_id`, `question_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_native_agent_ask_questions_position` ON `native_agent_ask_questions` (`request_id`,`position`);--> statement-breakpoint
CREATE TABLE `native_agent_asks` (
	`request_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`project_session_id` text NOT NULL,
	`member_instance_id` text NOT NULL,
	`mesh_session_id` text,
	`blocking` integer DEFAULT false NOT NULL,
	`state` text NOT NULL,
	`outcome` text,
	`answers` text,
	`expires_at` text,
	`created_at` text NOT NULL,
	`resolved_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_native_agent_asks_unresolved_member` ON `native_agent_asks` (`project_session_id`,`member_instance_id`) WHERE resolved_at IS NULL;--> statement-breakpoint
CREATE INDEX `idx_native_agent_asks_state_expiry` ON `native_agent_asks` (`state`,`expires_at`);--> statement-breakpoint
CREATE TABLE `native_agent_direct_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`mesh_session_id` text NOT NULL,
	`from_agent` text,
	`peer` text NOT NULL,
	`text` text NOT NULL,
	`attachment_ids` text,
	`request_id` text,
	`request_fingerprint` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_native_agent_direct_messages_session_peer` ON `native_agent_direct_messages` (`mesh_session_id`,`peer`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_native_agent_direct_messages_session_pair` ON `native_agent_direct_messages` (`session_id`,`from_agent`,`peer`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_native_agent_direct_messages_request` ON `native_agent_direct_messages` (`mesh_session_id`,`request_id`) WHERE request_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE `native_agent_ingress_items` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`member_instance_id` text NOT NULL,
	`mesh_session_id` text,
	`ingress_seq` integer NOT NULL,
	`source_kind` text NOT NULL,
	`message_seq` integer,
	`message_id` text,
	`direct_message_id` text,
	`delivery_id` text,
	`state` text DEFAULT 'queued' NOT NULL,
	`claim_batch_id` text,
	`provider_session_ref` text,
	`provider_turn_id` text,
	`error_summary` text,
	`created_at` text NOT NULL,
	`delivered_at` text,
	`visible_at` text,
	`consumed_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_native_agent_ingress_member_seq` ON `native_agent_ingress_items` (`project_id`,`member_instance_id`,`ingress_seq`);--> statement-breakpoint
CREATE INDEX `idx_native_agent_ingress_member_state` ON `native_agent_ingress_items` (`project_id`,`member_instance_id`,`state`,`ingress_seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_native_agent_ingress_message` ON `native_agent_ingress_items` (`project_id`,`member_instance_id`,`message_id`) WHERE message_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_native_agent_ingress_direct` ON `native_agent_ingress_items` (`direct_message_id`) WHERE direct_message_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_native_agent_ingress_delivery` ON `native_agent_ingress_items` (`delivery_id`) WHERE delivery_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_native_agent_ingress_claim` ON `native_agent_ingress_items` (`claim_batch_id`,`ingress_seq`);--> statement-breakpoint
CREATE TABLE `native_agent_member_gates` (
	`project_id` text NOT NULL,
	`project_session_id` text NOT NULL,
	`member_instance_id` text NOT NULL,
	`request_id` text NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`project_session_id`, `member_instance_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_native_agent_member_gates_request` ON `native_agent_member_gates` (`request_id`);--> statement-breakpoint
CREATE TABLE `native_agent_reconcile_failures` (
	`id` text PRIMARY KEY NOT NULL,
	`source_table` text NOT NULL,
	`project_id` text,
	`session_id` text,
	`legacy_member_key` text NOT NULL,
	`candidate_count` integer NOT NULL,
	`reason` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_native_agent_reconcile_failures_source` ON `native_agent_reconcile_failures` (`source_table`,`project_id`);--> statement-breakpoint
CREATE TABLE `native_agent_recovery_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`member_instance_id` text NOT NULL,
	`ask_request_id` text,
	`high_water_seq` integer NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_native_agent_recovery_member_state` ON `native_agent_recovery_batches` (`project_id`,`member_instance_id`,`state`);--> statement-breakpoint
CREATE TABLE `project_members` (
	`project_id` text NOT NULL,
	`id` text NOT NULL,
	`profile_id` text NOT NULL,
	`type` text NOT NULL,
	`display_name` text NOT NULL,
	`custom_prompt` text,
	`launch_overrides` text DEFAULT '{}' NOT NULL,
	`working_directory_override` text,
	`lifecycle` text DEFAULT 'enabled' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`project_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `idx_project_members_project_lifecycle` ON `project_members` (`project_id`,`lifecycle`);--> statement-breakpoint
CREATE TABLE `session_attention_items` (
	`item_key` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`occurred_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_session_attention_session` ON `session_attention_items` (`session_id`,`kind`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_session_attention_source` ON `session_attention_items` (`session_id`,`source_type`,`source_id`);--> statement-breakpoint
CREATE TABLE `session_bindings` (
	`session_id` text NOT NULL,
	`project_member_id` text NOT NULL,
	`last_delivered_seq` integer DEFAULT 0 NOT NULL,
	`last_visible_seq` integer DEFAULT 0 NOT NULL,
	`current_native_runtime_session_id` text,
	`lifecycle` text DEFAULT 'active' NOT NULL,
	`last_health` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`session_id`, `project_member_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_session_bindings_member` ON `session_bindings` (`project_member_id`,`session_id`);--> statement-breakpoint
CREATE INDEX `idx_session_bindings_runtime` ON `session_bindings` (`current_native_runtime_session_id`);--> statement-breakpoint
CREATE TABLE `session_members` (
	`session_id` text NOT NULL,
	`member_id` text NOT NULL,
	`template_id` text,
	`type` text NOT NULL,
	`mesh_session_id` text,
	`data` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`session_id`, `member_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_session_members_session` ON `session_members` (`session_id`);--> statement-breakpoint
CREATE TABLE `session_plan_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`request_id` text NOT NULL,
	`operation` text NOT NULL,
	`todo_id` text,
	`source` text NOT NULL,
	`project_member_id` text,
	`resource_version` integer,
	`outcome` text NOT NULL,
	`error_code` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_session_plan_audit_session` ON `session_plan_audit_log` (`session_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `session_plan_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`session_id` text NOT NULL,
	`request_id` text NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL,
	`published_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_session_plan_events_id` ON `session_plan_events` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_session_plan_events_request` ON `session_plan_events` (`session_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `idx_session_plan_events_pending` ON `session_plan_events` (`published_at`,`sequence`);--> statement-breakpoint
CREATE TABLE `session_plan_mutations` (
	`session_id` text NOT NULL,
	`request_id` text NOT NULL,
	`operation` text NOT NULL,
	`command_fingerprint` text NOT NULL,
	`result` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`session_id`, `request_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_session_plan_mutations_created` ON `session_plan_mutations` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `session_plan_todos` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`text` text NOT NULL,
	`status` text NOT NULL,
	`assignee_project_member_id` text,
	`version` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_session_plan_todos_session` ON `session_plan_todos` (`session_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `session_plans` (
	`session_id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
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
	`activity_at` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_project` ON `sessions` (`project_id`);--> statement-breakpoint
CREATE TABLE `tool_raw_outputs` (
	`transcript_target_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`output` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`transcript_target_id`, `tool_call_id`)
);
--> statement-breakpoint
CREATE TABLE `transcript_message_revisions` (
	`transcript_target_id` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE `workplace_project_order` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL
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
	`sort_rank` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_workplace_projects_state` ON `workplace_projects` (`state`,`archived`);
--> statement-breakpoint
CREATE TABLE `mesh_agent_usage_records` (
	`provider` text NOT NULL,
	`agent_name` text NOT NULL,
	`name` text NOT NULL,
	`current` real NOT NULL,
	`max` real,
	`reset_at` text,
	`checked_at` text NOT NULL,
	PRIMARY KEY(`provider`, `agent_name`, `name`)
);
--> statement-breakpoint
CREATE INDEX `idx_mesh_agent_usage_records_provider` ON `mesh_agent_usage_records` (`provider`,`agent_name`);
--> statement-breakpoint
CREATE TABLE `mesh_agent_usage_snapshots` (
	`provider` text NOT NULL,
	`agent_name` text NOT NULL,
	`checked_at` text NOT NULL,
	PRIMARY KEY(`provider`, `agent_name`)
);
--> statement-breakpoint
CREATE TABLE `mesh_session_usage_snapshots` (
	`mesh_session_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`project_id` text,
	`provider` text NOT NULL,
	`agent_name` text NOT NULL,
	`total` real NOT NULL,
	`input` real NOT NULL,
	`output` real NOT NULL,
	`checked_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_mesh_session_usage_project` ON `mesh_session_usage_snapshots` (`project_id`);
--> statement-breakpoint
CREATE INDEX `idx_mesh_session_usage_provider_agent` ON `mesh_session_usage_snapshots` (`provider`,`agent_name`);
