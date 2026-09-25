CREATE TABLE `apps` (
  `id` text PRIMARY KEY NOT NULL,
  `slug` text NOT NULL,
  `name` text NOT NULL,
  `package_name` text,
  `passcode_hash` text,
  `created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `apps_slug_unique` ON `apps` (`slug`);
--> statement-breakpoint
CREATE TABLE `builds` (
  `id` text PRIMARY KEY NOT NULL,
  `app_id` text NOT NULL REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade,
  `version_name` text NOT NULL,
  `version_code` integer NOT NULL,
  `r2_key` text NOT NULL,
  `size_bytes` integer NOT NULL,
  `commit_sha` text,
  `notes` text,
  `uploaded_by` text NOT NULL,
  `uploaded_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  `downloads` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `builds_r2_key_unique` ON `builds` (`r2_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `builds_app_version_code_unique` ON `builds` (`app_id`, `version_code`);
--> statement-breakpoint
CREATE INDEX `builds_app_uploaded_at_idx` ON `builds` (`app_id`, `uploaded_at`);
