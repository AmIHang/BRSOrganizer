CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`notes` text,
	`link` text,
	`due_at` integer,
	`starts_at` integer,
	`ends_at` integer,
	`status` text DEFAULT 'open' NOT NULL,
	`source` text NOT NULL,
	`external_id` text,
	`meta` text,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	`status_changed_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	`last_seen_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `items_source_external_id_uq` ON `items` (`source`,`external_id`);--> statement-breakpoint
CREATE INDEX `items_status_idx` ON `items` (`status`);--> statement-breakpoint
CREATE INDEX `items_due_at_idx` ON `items` (`due_at`);--> statement-breakpoint
CREATE INDEX `items_starts_at_idx` ON `items` (`starts_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`ok` integer DEFAULT false NOT NULL,
	`added` integer DEFAULT 0 NOT NULL,
	`updated` integer DEFAULT 0 NOT NULL,
	`closed` integer DEFAULT 0 NOT NULL,
	`reopened` integer DEFAULT 0 NOT NULL,
	`error` text
);
