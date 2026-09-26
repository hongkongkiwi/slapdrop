ALTER TABLE `upload_intents` ADD `state` text DEFAULT 'pending' NOT NULL;
--> statement-breakpoint
ALTER TABLE `upload_intents` ADD `build_id` text;
