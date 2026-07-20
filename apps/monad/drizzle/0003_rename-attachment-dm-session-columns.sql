-- Custom SQL migration file, put your code below! --
-- `message_attachments.project_id` and `native_agent_direct_messages.project_id` have always held
-- a session id (transcript_target_id / mesh session's session), never a `prj_*` Workplace Project
-- id. The column name was wrong from day one, which made every delete path keyed on it silently
-- match zero rows. Rename to the value the column actually holds.
ALTER TABLE `message_attachments` RENAME COLUMN `project_id` TO `session_id`;
--> statement-breakpoint
DROP INDEX `idx_message_attachments_project`;
--> statement-breakpoint
CREATE INDEX `idx_message_attachments_session` ON `message_attachments` (`session_id`);
--> statement-breakpoint
ALTER TABLE `native_agent_direct_messages` RENAME COLUMN `project_id` TO `session_id`;
--> statement-breakpoint
DROP INDEX `idx_native_agent_direct_messages_project_pair`;
--> statement-breakpoint
CREATE INDEX `idx_native_agent_direct_messages_session_pair` ON `native_agent_direct_messages` (`session_id`,`from_agent`,`peer`,`created_at`);
--> statement-breakpoint

-- Repair pass — two independent leaks the rename above does not fix by itself:
--
-- (A) `deleteWorkplaceProject` never cascaded to the sessions it owns: it deleted rows matching
--     `transcript_target_id = <prj_id>` / `project_id = <prj_id>`, which never matched anything
--     scoped by session id, and it never touched the `sessions` table at all. A project delete
--     left every contained session's messages, events, tool output, DMs, and attachments in
--     place, with the session still pointing at a `project_id` that no longer resolves.
--
-- (B) `deleteSession` used the same mislabeled `project_id` column for direct messages and (once
--     attachments existed) would have missed attachments too, leaving those two tables' rows
--     behind for sessions that otherwise deleted cleanly.
--
-- Both leave orphaned data now that ownership is named correctly, so purge it in one pass: first
-- everything owned by a "zombie" session (a session whose project was deleted out from under it),
-- then the zombie sessions themselves, then anything in the two renamed tables that still points
-- at a session id no longer present at all (case B).

DELETE FROM `message_embeddings`
WHERE `message_id` IN (
  SELECT `id` FROM `messages` WHERE `transcript_target_id` IN (
    SELECT `id` FROM `sessions`
    WHERE `project_id` IS NOT NULL AND `project_id` NOT IN (SELECT `id` FROM `workplace_projects`)
  )
);
--> statement-breakpoint
DELETE FROM `tasks`
WHERE `session_id` IN (
  SELECT `id` FROM `sessions`
  WHERE `project_id` IS NOT NULL AND `project_id` NOT IN (SELECT `id` FROM `workplace_projects`)
);
--> statement-breakpoint
DELETE FROM `memory`
WHERE `session_id` IN (
  SELECT `id` FROM `sessions`
  WHERE `project_id` IS NOT NULL AND `project_id` NOT IN (SELECT `id` FROM `workplace_projects`)
);
--> statement-breakpoint
DELETE FROM `file_observations`
WHERE `session_id` IN (
  SELECT `id` FROM `sessions`
  WHERE `project_id` IS NOT NULL AND `project_id` NOT IN (SELECT `id` FROM `workplace_projects`)
);
--> statement-breakpoint
DELETE FROM `messages`
WHERE `transcript_target_id` IN (
  SELECT `id` FROM `sessions`
  WHERE `project_id` IS NOT NULL AND `project_id` NOT IN (SELECT `id` FROM `workplace_projects`)
);
--> statement-breakpoint
DELETE FROM `events`
WHERE `transcript_target_id` IN (
  SELECT `id` FROM `sessions`
  WHERE `project_id` IS NOT NULL AND `project_id` NOT IN (SELECT `id` FROM `workplace_projects`)
);
--> statement-breakpoint
DELETE FROM `tool_raw_outputs`
WHERE `transcript_target_id` IN (
  SELECT `id` FROM `sessions`
  WHERE `project_id` IS NOT NULL AND `project_id` NOT IN (SELECT `id` FROM `workplace_projects`)
);
--> statement-breakpoint
DELETE FROM `acp_delegates`
WHERE `session_id` IN (
  SELECT `id` FROM `sessions`
  WHERE `project_id` IS NOT NULL AND `project_id` NOT IN (SELECT `id` FROM `workplace_projects`)
);
--> statement-breakpoint
DELETE FROM `channel_conversation_sessions`
WHERE `session_id` IN (
  SELECT `id` FROM `sessions`
  WHERE `project_id` IS NOT NULL AND `project_id` NOT IN (SELECT `id` FROM `workplace_projects`)
);
--> statement-breakpoint
DELETE FROM `channel_conversations`
WHERE `active_session_id` IN (
  SELECT `id` FROM `sessions`
  WHERE `project_id` IS NOT NULL AND `project_id` NOT IN (SELECT `id` FROM `workplace_projects`)
);
--> statement-breakpoint
DELETE FROM `mesh_agent_inbox_items`
WHERE `mesh_session_id` IN (
  SELECT `id` FROM `mesh_sessions` WHERE `transcript_target_id` IN (
    SELECT `id` FROM `sessions`
    WHERE `project_id` IS NOT NULL AND `project_id` NOT IN (SELECT `id` FROM `workplace_projects`)
  )
);
--> statement-breakpoint
DELETE FROM `mesh_sessions`
WHERE `transcript_target_id` IN (
  SELECT `id` FROM `sessions`
  WHERE `project_id` IS NOT NULL AND `project_id` NOT IN (SELECT `id` FROM `workplace_projects`)
);
--> statement-breakpoint
DELETE FROM `native_agent_direct_messages`
WHERE `session_id` IN (
  SELECT `id` FROM `sessions`
  WHERE `project_id` IS NOT NULL AND `project_id` NOT IN (SELECT `id` FROM `workplace_projects`)
);
--> statement-breakpoint
DELETE FROM `message_attachments`
WHERE `session_id` IN (
  SELECT `id` FROM `sessions`
  WHERE `project_id` IS NOT NULL AND `project_id` NOT IN (SELECT `id` FROM `workplace_projects`)
);
--> statement-breakpoint
DELETE FROM `sessions`
WHERE `project_id` IS NOT NULL AND `project_id` NOT IN (SELECT `id` FROM `workplace_projects`);
--> statement-breakpoint
DELETE FROM `experience_state` WHERE `project_id` NOT IN (SELECT `id` FROM `workplace_projects`);
--> statement-breakpoint
DELETE FROM `experience_state_events` WHERE `project_id` NOT IN (SELECT `id` FROM `workplace_projects`);
--> statement-breakpoint
DELETE FROM `experience_worker_wakeups` WHERE `project_id` NOT IN (SELECT `id` FROM `workplace_projects`);
--> statement-breakpoint

-- Case (B): rows in the two renamed tables left behind by an individually-deleted session (the
-- session row itself is already gone, so these can't be reached by the project-zombie sweep above).
DELETE FROM `native_agent_direct_messages`
WHERE `session_id` NOT IN (SELECT `id` FROM `sessions`);
--> statement-breakpoint
DELETE FROM `message_attachments`
WHERE `session_id` NOT IN (SELECT `id` FROM `sessions`);
