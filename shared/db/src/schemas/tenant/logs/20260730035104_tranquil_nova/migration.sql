CREATE TABLE `alarms` (
	`id` blob PRIMARY KEY,
	`callee` text NOT NULL,
	`payload` text DEFAULT '[]' NOT NULL,
	`type` text NOT NULL,
	`next_time` integer NOT NULL,
	`delay_in_seconds` integer,
	`cron` text
) WITHOUT ROWID, STRICT;
--> statement-breakpoint
CREATE TABLE `logs` (
	`id` blob PRIMARY KEY,
	`timestamp` integer NOT NULL,
	`event_type` integer NOT NULL,
	`context` text NOT NULL,
	`ip` text,
	`user_agent` text,
	`ray_id` blob,
	`u_id` blob,
	`ak_id` blob,
	`system` integer,
	`kr_id` blob,
	`dk_id` blob,
	`status` integer NOT NULL,
	CONSTRAINT "actor_required" CHECK(((("u_id" is not null)) or (("ak_id" is not null)) or (("system" is not null))))
) WITHOUT ROWID, STRICT;
--> statement-breakpoint
CREATE TABLE `pending_web_sockets` (
	`id` blob PRIMARY KEY,
	`secret` blob NOT NULL UNIQUE,
	`salt` blob NOT NULL UNIQUE,
	`expires` integer NOT NULL,
	CONSTRAINT "valid_expire" CHECK("expires" > (CAST(unixepoch('subsec') * 1000 AS INTEGER)))
) WITHOUT ROWID, STRICT;
--> statement-breakpoint
CREATE TABLE `web_sockets_subscriptions` (
	`id` blob NOT NULL,
	`event_type` integer NOT NULL,
	CONSTRAINT `web_sockets_subscriptions_pk` PRIMARY KEY(`id`, `event_type`)
) WITHOUT ROWID, STRICT;
--> statement-breakpoint
CREATE INDEX `idx_alarms_type` ON `alarms` (`type`);--> statement-breakpoint
CREATE INDEX `idx_alarms_next_time` ON `alarms` (`next_time`);--> statement-breakpoint
CREATE INDEX `event_type_idx` ON `logs` (`event_type`);--> statement-breakpoint
CREATE INDEX `when` ON `logs` (`timestamp`);--> statement-breakpoint
CREATE INDEX `u_id_event_type_idx` ON `logs` (`u_id`,`event_type`);--> statement-breakpoint
CREATE INDEX `ak_id_event_type_idx` ON `logs` (`ak_id`,`event_type`);