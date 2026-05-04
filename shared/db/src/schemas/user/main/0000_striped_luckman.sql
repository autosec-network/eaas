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
CREATE TABLE `auth_accounts` (
	`type` text NOT NULL,
	`provider` text NOT NULL,
	`provider_account_id` text NOT NULL,
	`refresh_token` blob,
	`access_token` blob,
	`expires_at` integer,
	`token_type` text,
	`scope` text,
	`id_token` blob,
	`session_state` text,
	PRIMARY KEY(`provider`, `provider_account_id`)
);
--> statement-breakpoint
CREATE TABLE `auth_verification_token` (
	`hashed_token` blob PRIMARY KEY NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `auth_webauthn` (
	`credential_id` blob PRIMARY KEY NOT NULL,
	`name` text,
	`aa_guid` blob,
	`credential_public_key` blob NOT NULL,
	`counter` integer NOT NULL,
	`credential_device_type` text NOT NULL,
	`credential_backed_up` integer NOT NULL,
	`transports` text,
	`a_time` integer NOT NULL,
	`b_time` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_webauthn_name_unique` ON `auth_webauthn` (`name`);