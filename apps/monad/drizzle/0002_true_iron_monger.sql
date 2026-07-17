CREATE TABLE `external_agent_observation_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`external_agent_session_id` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`event_json` text NOT NULL,
	`observed_at` text NOT NULL,
	FOREIGN KEY (`external_agent_session_id`) REFERENCES `external_agent_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_external_agent_observation_dedupe` ON `external_agent_observation_events` (`external_agent_session_id`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `idx_external_agent_observation_page` ON `external_agent_observation_events` (`external_agent_session_id`,`seq`);