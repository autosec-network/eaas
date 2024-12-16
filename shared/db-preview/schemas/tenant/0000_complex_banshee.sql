CREATE TABLE `api_keys` (
	`ak_id` blob PRIMARY KEY NOT NULL,
	`ak_id_utf8` text GENERATED ALWAYS AS (lower(format('%s-%s-%s-%s-%s', substr(hex("ak_id"),1,8), substr(hex("ak_id"),9,4), substr(hex("ak_id"),13,4), substr(hex("ak_id"),17,4), substr(hex("ak_id"),21)))) VIRTUAL,
	`name` text NOT NULL,
	`hash` blob NOT NULL,
	`expires` text NOT NULL,
	`a_time` text(24),
	`b_time` text(24) DEFAULT (strftime('%FT%H:%M:%fZ', CURRENT_TIMESTAMP)) NOT NULL,
	`c_time` text(24) DEFAULT (strftime('%FT%H:%M:%fZ', CURRENT_TIMESTAMP)) NOT NULL,
	`m_time` text(24) DEFAULT (strftime('%FT%H:%M:%fZ', CURRENT_TIMESTAMP)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash_unique` ON `api_keys` (`hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `case_insensitive_apikey_name` ON `api_keys` (lower("name"));--> statement-breakpoint
CREATE TABLE `api_keys_keyrings` (
	`ak_id` blob PRIMARY KEY NOT NULL,
	`ak_id_utf8` text GENERATED ALWAYS AS (lower(format('%s-%s-%s-%s-%s', substr(hex("ak_id"),1,8), substr(hex("ak_id"),9,4), substr(hex("ak_id"),13,4), substr(hex("ak_id"),17,4), substr(hex("ak_id"),21)))) VIRTUAL,
	`kr_id` blob NOT NULL,
	`kr_id_utf8` text GENERATED ALWAYS AS (lower(format('%s-%s-%s-%s-%s', substr(hex("kr_id"),1,8), substr(hex("kr_id"),9,4), substr(hex("kr_id"),13,4), substr(hex("kr_id"),17,4), substr(hex("kr_id"),21)))) VIRTUAL,
	`r_encrypt` integer DEFAULT true NOT NULL,
	`r_decrypt` integer DEFAULT false NOT NULL,
	`r_rewrap` integer DEFAULT true NOT NULL,
	`r_sign` integer DEFAULT true NOT NULL,
	`r_verify` integer DEFAULT true NOT NULL,
	`r_hmac` integer DEFAULT true NOT NULL,
	`r_random` integer DEFAULT true NOT NULL,
	`r_hash` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`ak_id`) REFERENCES `api_keys`(`ak_id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`kr_id`) REFERENCES `keyrings`(`kr_id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_keyrings_kr_id_ak_id_unique` ON `api_keys_keyrings` (`kr_id`,`ak_id`);--> statement-breakpoint
CREATE TABLE `datakeys` (
	`dk_id` blob PRIMARY KEY NOT NULL,
	`dk_id_utf8` text GENERATED ALWAYS AS (lower(format('%s-%s-%s-%s-%s', substr(hex("dk_id"),1,8), substr(hex("dk_id"),9,4), substr(hex("dk_id"),13,4), substr(hex("dk_id"),17,4), substr(hex("dk_id"),21)))) VIRTUAL,
	`kr_id` blob NOT NULL,
	`kr_id_utf8` text GENERATED ALWAYS AS (lower(format('%s-%s-%s-%s-%s', substr(hex("kr_id"),1,8), substr(hex("kr_id"),9,4), substr(hex("kr_id"),13,4), substr(hex("kr_id"),17,4), substr(hex("kr_id"),21)))) VIRTUAL,
	`bw_id` blob,
	`bw_id_utf8` text GENERATED ALWAYS AS (lower(format('%s-%s-%s-%s-%s', substr(hex("bw_id"),1,8), substr(hex("bw_id"),9,4), substr(hex("bw_id"),13,4), substr(hex("bw_id"),17,4), substr(hex("bw_id"),21)))) VIRTUAL,
	`a_time` text(24),
	`b_time` text(24) DEFAULT (strftime('%FT%H:%M:%fZ', CURRENT_TIMESTAMP)) NOT NULL,
	`generation_count` blob DEFAULT (unhex(00)) NOT NULL,
	FOREIGN KEY (`kr_id`) REFERENCES `keyrings`(`kr_id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `datakeys_bw_id_unique` ON `datakeys` (`bw_id`);--> statement-breakpoint
CREATE TABLE `keyrings` (
	`kr_id` blob PRIMARY KEY NOT NULL,
	`kr_id_utf8` text GENERATED ALWAYS AS (lower(format('%s-%s-%s-%s-%s', substr(hex("kr_id"),1,8), substr(hex("kr_id"),9,4), substr(hex("kr_id"),13,4), substr(hex("kr_id"),17,4), substr(hex("kr_id"),21)))) VIRTUAL,
	`name` text NOT NULL,
	`plaintext_export` integer DEFAULT false NOT NULL,
	`key_type` text NOT NULL,
	`key_size` integer,
	`hash` text NOT NULL,
	`time_rotation` integer DEFAULT true NOT NULL,
	`count_rotation` blob DEFAULT (unhex(0100000000)),
	`generation_versions` integer DEFAULT 0 NOT NULL,
	`retreival_versions` integer DEFAULT 2 NOT NULL,
	`b_time` text(24) DEFAULT (strftime('%FT%H:%M:%fZ', CURRENT_TIMESTAMP)) NOT NULL,
	`c_time` text(24) DEFAULT (strftime('%FT%H:%M:%fZ', CURRENT_TIMESTAMP)) NOT NULL,
	`m_time` text(24) DEFAULT (strftime('%FT%H:%M:%fZ', CURRENT_TIMESTAMP)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `case_insensitive_keyring_name` ON `keyrings` (lower("name"));--> statement-breakpoint
CREATE TABLE `properties` (
	`t_id` blob PRIMARY KEY NOT NULL,
	`t_id_utf8` text GENERATED ALWAYS AS (lower(format('%s-%s-%s-%s-%s', substr(hex("t_id"),1,8), substr(hex("t_id"),9,4), substr(hex("t_id"),13,4), substr(hex("t_id"),17,4), substr(hex("t_id"),21)))) VIRTUAL,
	`d1_id` blob NOT NULL,
	`d1_id_utf8` text GENERATED ALWAYS AS (lower(format('%s-%s-%s-%s-%s', substr(hex("d1_id"),1,8), substr(hex("d1_id"),9,4), substr(hex("d1_id"),13,4), substr(hex("d1_id"),17,4), substr(hex("d1_id"),21)))) VIRTUAL,
	`name` text NOT NULL,
	`avatar` text,
	`flags` text DEFAULT '{}' NOT NULL,
	`b_time` text(24) DEFAULT (strftime('%FT%H:%M:%fZ', CURRENT_TIMESTAMP)) NOT NULL,
	`c_time` text(24) DEFAULT (strftime('%FT%H:%M:%fZ', CURRENT_TIMESTAMP)) NOT NULL,
	`bw_url` text,
	`bw_id` blob,
	`bw_id_utf8` text GENERATED ALWAYS AS (lower(format('%s-%s-%s-%s-%s', substr(hex("bw_id"),1,8), substr(hex("bw_id"),9,4), substr(hex("bw_id"),13,4), substr(hex("bw_id"),17,4), substr(hex("bw_id"),21)))) VIRTUAL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `properties_d1_id_unique` ON `properties` (`d1_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `properties_name_unique` ON `properties` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `properties_avatar_unique` ON `properties` (`avatar`);--> statement-breakpoint
CREATE UNIQUE INDEX `properties_flags_unique` ON `properties` (`flags`);--> statement-breakpoint
CREATE UNIQUE INDEX `properties_b_time_unique` ON `properties` (`b_time`);--> statement-breakpoint
CREATE UNIQUE INDEX `properties_c_time_unique` ON `properties` (`c_time`);--> statement-breakpoint
CREATE UNIQUE INDEX `properties_bw_url_unique` ON `properties` (`bw_url`);--> statement-breakpoint
CREATE UNIQUE INDEX `properties_bw_id_unique` ON `properties` (`bw_id`);--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`s_id` blob PRIMARY KEY NOT NULL,
	`s_id_utf8` text GENERATED ALWAYS AS (lower(format('%s-%s-%s-%s-%s', substr(hex("s_id"),1,8), substr(hex("s_id"),9,4), substr(hex("s_id"),13,4), substr(hex("s_id"),17,4), substr(hex("s_id"),21)))) VIRTUAL,
	`u_id` blob NOT NULL,
	`u_id_utf8` text GENERATED ALWAYS AS (lower(format('%s-%s-%s-%s-%s', substr(hex("u_id"),1,8), substr(hex("u_id"),9,4), substr(hex("u_id"),13,4), substr(hex("u_id"),17,4), substr(hex("u_id"),21)))) VIRTUAL,
	`expires` text NOT NULL,
	`supplemental` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`u_id`) REFERENCES `users`(`u_id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_sessions_s_id_u_id_unique` ON `auth_sessions` (`s_id`,`u_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`u_id` blob PRIMARY KEY NOT NULL,
	`u_id_utf8` text GENERATED ALWAYS AS (lower(format('%s-%s-%s-%s-%s', substr(hex("u_id"),1,8), substr(hex("u_id"),9,4), substr(hex("u_id"),13,4), substr(hex("u_id"),17,4), substr(hex("u_id"),21)))) VIRTUAL,
	`d1_id` blob NOT NULL,
	`d1_id_utf8` text GENERATED ALWAYS AS (lower(format('%s-%s-%s-%s-%s', substr(hex("d1_id"),1,8), substr(hex("d1_id"),9,4), substr(hex("d1_id"),13,4), substr(hex("d1_id"),17,4), substr(hex("d1_id"),21)))) VIRTUAL,
	`email` text NOT NULL,
	`flags` text DEFAULT '{}' NOT NULL,
	`a_time` text(24),
	`b_time` text(24) DEFAULT (strftime('%FT%H:%M:%fZ', CURRENT_TIMESTAMP)) NOT NULL,
	`m_time` text(24) DEFAULT (strftime('%FT%H:%M:%fZ', CURRENT_TIMESTAMP)) NOT NULL,
	`approved` integer DEFAULT false NOT NULL,
	`r_tenant` integer DEFAULT 1 NOT NULL,
	`r_users` integer DEFAULT 1 NOT NULL,
	`r_roles` integer DEFAULT 1 NOT NULL,
	`r_billing` integer DEFAULT 0 NOT NULL,
	`r_keyring` integer DEFAULT 2 NOT NULL,
	`r_datakey` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_d1_id_unique` ON `users` (`d1_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `case_insensitive_email` ON `users` (lower("email"));--> statement-breakpoint
CREATE TABLE `auth_webauthn` (
	`credential_id` blob PRIMARY KEY NOT NULL,
	`u_id` blob NOT NULL,
	`u_id_utf8` text GENERATED ALWAYS AS (lower(format('%s-%s-%s-%s-%s', substr(hex("u_id"),1,8), substr(hex("u_id"),9,4), substr(hex("u_id"),13,4), substr(hex("u_id"),17,4), substr(hex("u_id"),21)))) VIRTUAL,
	`name` text,
	`credential_public_key` blob NOT NULL,
	`counter` integer NOT NULL,
	`credential_device_type` text NOT NULL,
	`credential_backed_up` integer NOT NULL,
	`transports` text,
	`a_time` text(24),
	`b_time` text(24) DEFAULT (strftime('%FT%H:%M:%fZ', CURRENT_TIMESTAMP)) NOT NULL,
	FOREIGN KEY (`u_id`) REFERENCES `users`(`u_id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_webauthn_credential_public_key_unique` ON `auth_webauthn` (`credential_public_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `auth_webauthn_u_id_name_unique` ON `auth_webauthn` (`u_id`,`name`);