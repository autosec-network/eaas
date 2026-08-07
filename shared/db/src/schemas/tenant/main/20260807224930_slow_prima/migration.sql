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
CREATE TABLE `api_keys` (
	`ak_id` blob PRIMARY KEY,
	`name` text NOT NULL,
	`hash` blob NOT NULL UNIQUE,
	`last_identifier` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`expires` integer NOT NULL,
	`a_time` integer,
	`b_time` integer NOT NULL,
	`c_time` integer NOT NULL,
	`m_time` integer NOT NULL,
	`r_keyrings` integer DEFAULT 0 NOT NULL,
	`r_apikeys` integer DEFAULT 0 NOT NULL
) WITHOUT ROWID, STRICT;
--> statement-breakpoint
CREATE TABLE `api_keys_keyrings` (
	`ak_id` blob NOT NULL,
	`kr_id` blob NOT NULL,
	`r_datakeys` integer DEFAULT 1 NOT NULL,
	`r_encrypt` integer DEFAULT true NOT NULL,
	`r_decrypt` integer DEFAULT false NOT NULL,
	`r_rewrap` integer DEFAULT true NOT NULL,
	`r_sign` integer DEFAULT true NOT NULL,
	`r_verify` integer DEFAULT true NOT NULL,
	`r_hmac` integer DEFAULT true NOT NULL,
	CONSTRAINT `api_keys_keyrings_pk` PRIMARY KEY(`kr_id`, `ak_id`),
	CONSTRAINT `fk_api_keys_keyrings_ak_id_api_keys_ak_id_fk` FOREIGN KEY (`ak_id`) REFERENCES `api_keys`(`ak_id`) ON UPDATE CASCADE ON DELETE CASCADE,
	CONSTRAINT `fk_api_keys_keyrings_kr_id_keyrings_kr_id_fk` FOREIGN KEY (`kr_id`) REFERENCES `keyrings`(`kr_id`) ON UPDATE CASCADE ON DELETE CASCADE
) WITHOUT ROWID, STRICT;
--> statement-breakpoint
CREATE TABLE `datakeys` (
	`dk_id` blob PRIMARY KEY,
	`kr_id` blob NOT NULL,
	`bw_id` blob UNIQUE,
	`a_time` integer,
	`generation_count` blob DEFAULT (unhex('00')) NOT NULL,
	CONSTRAINT `fk_datakeys_kr_id_keyrings_kr_id_fk` FOREIGN KEY (`kr_id`) REFERENCES `keyrings`(`kr_id`) ON UPDATE CASCADE ON DELETE CASCADE
) WITHOUT ROWID, STRICT;
--> statement-breakpoint
CREATE TABLE `keyrings` (
	`kr_id` blob PRIMARY KEY,
	`name` text NOT NULL,
	`plaintext_export` integer DEFAULT false NOT NULL,
	`key_type` text NOT NULL,
	`key_size` integer,
	`hash` text NOT NULL,
	`time_rotation` integer DEFAULT true NOT NULL,
	`count_rotation` blob DEFAULT (unhex('0100000000')),
	`generation_versions` integer DEFAULT 0 NOT NULL,
	`retreival_versions` integer DEFAULT 2 NOT NULL,
	`b_time` integer NOT NULL,
	`c_time` integer NOT NULL,
	`m_time` integer NOT NULL
) WITHOUT ROWID, STRICT;
--> statement-breakpoint
CREATE TABLE `users` (
	`u_id` blob PRIMARY KEY,
	`do_id` blob NOT NULL UNIQUE,
	`a_time` integer,
	`b_time` integer NOT NULL,
	`m_time` integer NOT NULL,
	`approved` integer DEFAULT false NOT NULL,
	`r_tenant` integer DEFAULT 1 NOT NULL,
	`r_users` integer DEFAULT 1 NOT NULL,
	`r_roles` integer DEFAULT 0 NOT NULL,
	`r_billing` integer DEFAULT 1 NOT NULL,
	`r_apikeys` integer DEFAULT 1 NOT NULL,
	`r_keyring` integer DEFAULT 2 NOT NULL,
	`r_datakey` integer DEFAULT 1 NOT NULL,
	`r_logs` integer DEFAULT 1 NOT NULL
) WITHOUT ROWID, STRICT;
--> statement-breakpoint
CREATE TABLE `users_keyrings` (
	`u_id` blob NOT NULL,
	`kr_id` blob NOT NULL,
	`r_keyring` integer DEFAULT 2 NOT NULL,
	`r_datakey` integer DEFAULT 1 NOT NULL,
	CONSTRAINT `users_keyrings_pk` PRIMARY KEY(`u_id`, `kr_id`),
	CONSTRAINT `fk_users_keyrings_u_id_users_u_id_fk` FOREIGN KEY (`u_id`) REFERENCES `users`(`u_id`) ON UPDATE CASCADE ON DELETE CASCADE,
	CONSTRAINT `fk_users_keyrings_kr_id_keyrings_kr_id_fk` FOREIGN KEY (`kr_id`) REFERENCES `keyrings`(`kr_id`) ON UPDATE CASCADE ON DELETE CASCADE
) WITHOUT ROWID, STRICT;
--> statement-breakpoint
CREATE INDEX `idx_alarms_type` ON `alarms` (`type`);--> statement-breakpoint
CREATE INDEX `idx_alarms_next_time` ON `alarms` (`next_time`);--> statement-breakpoint
CREATE UNIQUE INDEX `case_insensitive_apikey_name` ON `api_keys` (lower("name"));--> statement-breakpoint
CREATE INDEX `idx_api_keys_b_time` ON `api_keys` (`b_time`);--> statement-breakpoint
CREATE INDEX `idx_api_keys_keyrings_ak_id` ON `api_keys_keyrings` (`ak_id`);--> statement-breakpoint
CREATE INDEX `idx_api_keys_keyrings_kr_id` ON `api_keys_keyrings` (`kr_id`);--> statement-breakpoint
CREATE INDEX `idx_datakeys_kr_id` ON `datakeys` (`kr_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `case_insensitive_keyring_name` ON `keyrings` (lower("name"));--> statement-breakpoint
CREATE INDEX `idx_keyrings_name` ON `keyrings` (`name`);--> statement-breakpoint
CREATE INDEX `idx_users_keyrings_u_id` ON `users_keyrings` (`u_id`);--> statement-breakpoint
CREATE INDEX `idx_users_keyrings_kr_id` ON `users_keyrings` (`kr_id`);