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
CREATE TABLE `api_keys` (
	`ak_id` blob PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`hash` blob NOT NULL,
	`last_identifier` text(4) NOT NULL,
	`expires` integer NOT NULL,
	`a_time` integer,
	`b_time` integer NOT NULL,
	`c_time` integer NOT NULL,
	`m_time` integer NOT NULL,
	`r_keyrings` integer DEFAULT 0 NOT NULL,
	`r_apikeys` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash_unique` ON `api_keys` (`hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `case_insensitive_apikey_name` ON `api_keys` (lower("name"));--> statement-breakpoint
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
	PRIMARY KEY(`kr_id`, `ak_id`),
	FOREIGN KEY (`ak_id`) REFERENCES `api_keys`(`ak_id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`kr_id`) REFERENCES `keyrings`(`kr_id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `datakeys` (
	`dk_id` blob PRIMARY KEY NOT NULL,
	`do_id` blob NOT NULL,
	`kr_id` blob NOT NULL,
	`bw_id` blob,
	`a_time` integer,
	`b_time` integer NOT NULL,
	`generation_count` blob DEFAULT (unhex('00')) NOT NULL,
	FOREIGN KEY (`kr_id`) REFERENCES `keyrings`(`kr_id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `datakeys_do_id_unique` ON `datakeys` (`do_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `datakeys_bw_id_unique` ON `datakeys` (`bw_id`);--> statement-breakpoint
CREATE TABLE `keyrings` (
	`kr_id` blob PRIMARY KEY NOT NULL,
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
);
--> statement-breakpoint
CREATE UNIQUE INDEX `case_insensitive_keyring_name` ON `keyrings` (lower("name"));--> statement-breakpoint
CREATE TABLE `users` (
	`u_id` blob PRIMARY KEY NOT NULL,
	`do_id` blob NOT NULL,
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
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_do_id_unique` ON `users` (`do_id`);--> statement-breakpoint
CREATE TABLE `users_keyrings` (
	`u_id` blob NOT NULL,
	`kr_id` blob NOT NULL,
	`r_keyring` integer DEFAULT 2 NOT NULL,
	`r_datakey` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`u_id`) REFERENCES `users`(`u_id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`kr_id`) REFERENCES `keyrings`(`kr_id`) ON UPDATE cascade ON DELETE cascade
);
