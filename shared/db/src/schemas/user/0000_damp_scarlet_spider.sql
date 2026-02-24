CREATE TABLE `auth_accounts` (
	`type` text NOT NULL,
	`provider` text NOT NULL,
	`provider_account_id` text NOT NULL,
	`refresh_token` blob,
	`access_token` blob,
	`expires_at` text,
	`token_type` text,
	`scope` text,
	`id_token` blob,
	`session_state` text,
	PRIMARY KEY(`provider`, `provider_account_id`)
);
--> statement-breakpoint
CREATE TABLE `auth_verification_token` (
	`identifier` text NOT NULL,
	`hashed_token` blob NOT NULL,
	`timestamp` text(24) NOT NULL,
	PRIMARY KEY(`identifier`, `hashed_token`)
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
	`a_time` text(24) DEFAULT (strftime('%FT%H:%M:%fZ', CURRENT_TIMESTAMP)) NOT NULL,
	`b_time` text(24) DEFAULT (strftime('%FT%H:%M:%fZ', CURRENT_TIMESTAMP)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_webauthn_name_unique` ON `auth_webauthn` (`name`);