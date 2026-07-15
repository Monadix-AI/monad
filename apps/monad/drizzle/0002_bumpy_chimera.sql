CREATE TABLE `tool_raw_outputs` (
	`transcript_target_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`output` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`transcript_target_id`, `tool_call_id`)
);
