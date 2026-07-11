CREATE TABLE `api_keys_tenants` (
	`ak_id` blob PRIMARY KEY,
	`t_id` blob NOT NULL,
	`expires` integer NOT NULL,
	CONSTRAINT `fk_api_keys_tenants_t_id_tenants_t_id_fk` FOREIGN KEY (`t_id`) REFERENCES `tenants`(`t_id`) ON UPDATE CASCADE ON DELETE CASCADE,
	CONSTRAINT `api_keys_tenants_ak_id_t_id_unique` UNIQUE(`ak_id`,`t_id`)
) WITHOUT ROWID, STRICT;
--> statement-breakpoint
CREATE TABLE `tenants` (
	`t_id` blob PRIMARY KEY,
	`jurisdiction` text,
	`do_id` blob NOT NULL UNIQUE
) WITHOUT ROWID, STRICT;
--> statement-breakpoint
CREATE TABLE `users` (
	`u_id` blob PRIMARY KEY,
	`jurisdiction` text,
	`do_id` blob UNIQUE,
	`key_hash` blob NOT NULL,
	`email_key` blob NOT NULL UNIQUE,
	`user_init` integer DEFAULT false NOT NULL
) WITHOUT ROWID, STRICT;
--> statement-breakpoint
CREATE TABLE `users_auth_accounts` (
	`u_id` blob NOT NULL,
	`key_hash` blob NOT NULL,
	`provider` text NOT NULL,
	`provider_account_id` blob NOT NULL,
	CONSTRAINT `users_auth_accounts_pk` PRIMARY KEY(`provider`, `provider_account_id`),
	CONSTRAINT `fk_users_auth_accounts_u_id_users_u_id_fk` FOREIGN KEY (`u_id`) REFERENCES `users`(`u_id`) ON UPDATE CASCADE ON DELETE CASCADE
) WITHOUT ROWID, STRICT;
--> statement-breakpoint
CREATE TABLE `users_auth_sessions` (
	`u_id` blob NOT NULL,
	`session_token` blob PRIMARY KEY,
	`expires` integer NOT NULL,
	CONSTRAINT `fk_users_auth_sessions_u_id_users_u_id_fk` FOREIGN KEY (`u_id`) REFERENCES `users`(`u_id`) ON UPDATE CASCADE ON DELETE CASCADE
) WITHOUT ROWID, STRICT;
--> statement-breakpoint
CREATE TABLE `users_tenants` (
	`u_id` blob NOT NULL,
	`t_id` blob NOT NULL,
	CONSTRAINT `users_tenants_pk` PRIMARY KEY(`u_id`, `t_id`),
	CONSTRAINT `fk_users_tenants_u_id_users_u_id_fk` FOREIGN KEY (`u_id`) REFERENCES `users`(`u_id`) ON UPDATE CASCADE ON DELETE CASCADE,
	CONSTRAINT `fk_users_tenants_t_id_tenants_t_id_fk` FOREIGN KEY (`t_id`) REFERENCES `tenants`(`t_id`) ON UPDATE CASCADE ON DELETE CASCADE
) WITHOUT ROWID, STRICT;
--> statement-breakpoint
CREATE INDEX `idx_api_keys_tenants_t_id` ON `api_keys_tenants` (`t_id`);--> statement-breakpoint
CREATE INDEX `idx_users_auth_accounts_u_id` ON `users_auth_accounts` (`u_id`);--> statement-breakpoint
CREATE INDEX `idx_users_auth_accounts_provider_account_id` ON `users_auth_accounts` (`provider`,`provider_account_id`);--> statement-breakpoint
CREATE INDEX `idx_users_auth_sessions_u_id` ON `users_auth_sessions` (`u_id`);--> statement-breakpoint
CREATE INDEX `idx_users_tenants_t_id` ON `users_tenants` (`t_id`);