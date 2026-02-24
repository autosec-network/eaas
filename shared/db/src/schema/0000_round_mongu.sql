CREATE TABLE `api_keys_tenants` (
	`ak_id` blob PRIMARY KEY NOT NULL,
	`t_id` blob NOT NULL,
	`expires` text NOT NULL,
	FOREIGN KEY (`t_id`) REFERENCES `tenants`(`t_id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_tenants_ak_id_t_id_unique` ON `api_keys_tenants` (`ak_id`,`t_id`);--> statement-breakpoint
CREATE TABLE `tenants` (
	`t_id` blob PRIMARY KEY NOT NULL,
	`do_id` blob NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tenants_do_id_unique` ON `tenants` (`do_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`u_id` blob PRIMARY KEY NOT NULL,
	`do_id` blob NOT NULL,
	`key_hash` blob NOT NULL,
	`email_key` blob NOT NULL,
	`user_init` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_do_id_unique` ON `users` (`do_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_key_unique` ON `users` (`email_key`);--> statement-breakpoint
CREATE TABLE `users_auth_accounts` (
	`u_id` blob NOT NULL,
	`key_hash` blob NOT NULL,
	`provider` text NOT NULL,
	`provider_account_id` text NOT NULL,
	PRIMARY KEY(`provider`, `provider_account_id`),
	FOREIGN KEY (`u_id`) REFERENCES `users`(`u_id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `users_auth_sessions` (
	`u_id` blob NOT NULL,
	`session_token` blob PRIMARY KEY NOT NULL,
	`expires` text NOT NULL,
	FOREIGN KEY (`u_id`) REFERENCES `users`(`u_id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `users_tenants` (
	`u_id` blob NOT NULL,
	`t_id` blob NOT NULL,
	PRIMARY KEY(`u_id`, `t_id`),
	FOREIGN KEY (`u_id`) REFERENCES `users`(`u_id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`t_id`) REFERENCES `tenants`(`t_id`) ON UPDATE cascade ON DELETE cascade
);
