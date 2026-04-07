CREATE TABLE `alarms` (
	`id` blob PRIMARY KEY NOT NULL,
	`callee` text NOT NULL,
	`payload` text DEFAULT '[]' NOT NULL,
	`type` text NOT NULL,
	`next_time` integer NOT NULL,
	`delay_in_seconds` integer,
	`cron` text
);
--> statement-breakpoint
CREATE TABLE `logs` (
	`id` blob PRIMARY KEY NOT NULL,
	`timestamp` integer NOT NULL,
	`event_type` integer NOT NULL,
	`context` text NOT NULL,
	`ip` text NOT NULL,
	`user_agent` text,
	`u_id` blob,
	`ak_id` blob,
	`system` integer,
	`kr_id` blob,
	`dk_id` blob,
	`status` integer NOT NULL,
	CONSTRAINT "actor_required" CHECK(("logs"."u_id" is not null or "logs"."ak_id" is not null or "logs"."system" is not null))
);
--> statement-breakpoint
CREATE INDEX `event_type_idx` ON `logs` (`event_type`);--> statement-breakpoint
CREATE INDEX `when` ON `logs` (`timestamp`);--> statement-breakpoint
CREATE INDEX `u_id_event_type_idx` ON `logs` (`u_id`,`event_type`);--> statement-breakpoint
CREATE INDEX `ak_id_event_type_idx` ON `logs` (`ak_id`,`event_type`);--> statement-breakpoint
CREATE TABLE `pending_web_sockets` (
	`id` blob PRIMARY KEY NOT NULL,
	`secret` blob NOT NULL,
	`salt` blob NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pending_web_sockets_secret_unique` ON `pending_web_sockets` (`secret`);--> statement-breakpoint
CREATE UNIQUE INDEX `pending_web_sockets_salt_unique` ON `pending_web_sockets` (`salt`);--> statement-breakpoint
CREATE TABLE `web_sockets_subscriptions` (
	`id` blob NOT NULL,
	`event_type` integer NOT NULL,
	PRIMARY KEY(`id`, `event_type`)
);
