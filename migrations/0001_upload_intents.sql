CREATE TABLE `upload_intents` (
  `id` text PRIMARY KEY NOT NULL,
  `app_id` text NOT NULL REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade,
  `r2_key` text NOT NULL,
  `filename` text NOT NULL,
  `expected_size_bytes` integer NOT NULL,
  `version_name` text,
  `version_code` integer,
  `notes` text,
  `commit_sha` text,
  `uploader` text NOT NULL,
  `expires_at` text NOT NULL,
  `created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `upload_intents_expires_at_idx` ON `upload_intents` (`expires_at`);
