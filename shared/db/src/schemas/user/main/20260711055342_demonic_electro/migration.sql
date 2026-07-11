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
	CONSTRAINT `auth_accounts_pk` PRIMARY KEY(`provider`, `provider_account_id`)
) WITHOUT ROWID, STRICT;
--> statement-breakpoint
CREATE TABLE `auth_verification_token` (
	`hashed_token` blob PRIMARY KEY,
	`expires` integer NOT NULL
) WITHOUT ROWID, STRICT;
--> statement-breakpoint
CREATE TABLE `auth_webauthn` (
	`credential_id` blob PRIMARY KEY,
	`name` text UNIQUE,
	`aa_guid` blob,
	`credential_public_key` blob NOT NULL,
	`counter` integer NOT NULL,
	`credential_device_type` text NOT NULL,
	`credential_backed_up` integer NOT NULL,
	`transports` text,
	`a_time` integer NOT NULL,
	`b_time` integer NOT NULL
) WITHOUT ROWID, STRICT;
--> statement-breakpoint
CREATE INDEX `idx_alarms_type` ON `alarms` (`type`);--> statement-breakpoint
CREATE INDEX `idx_alarms_next_time` ON `alarms` (`next_time`);--> statement-breakpoint
CREATE INDEX `idx_auth_verification_token_expires` ON `auth_verification_token` (`expires`);