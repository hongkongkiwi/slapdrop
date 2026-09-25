CREATE TABLE `passcode_attempts` (
  `id` text PRIMARY KEY NOT NULL,
  `app_id` text NOT NULL REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade,
  `client_key` text NOT NULL,
  `failures` integer DEFAULT 0 NOT NULL,
  `window_started_at` text NOT NULL,
  `locked_until` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `passcode_attempts_app_client_unique` ON `passcode_attempts` (`app_id`, `client_key`);
