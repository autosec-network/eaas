CREATE TABLE `api_keys_tenants` (
	`ak_id` blob PRIMARY KEY NOT NULL,
	`ak_id_utf8` text GENERATED ALWAYS AS (lower(format('%s-%s-%s-%s-%s', substr(hex("ak_id"),1,8), substr(hex("ak_id"),9,4), substr(hex("ak_id"),13,4), substr(hex("ak_id"),17,4), substr(hex("ak_id"),21)))) VIRTUAL,
	`t_id` blob NOT NULL,
	`t_id_utf8` text GENERATED ALWAYS AS (lower(format('%s-%s-%s-%s-%s', substr(hex("t_id"),1,8), substr(hex("t_id"),9,4), substr(hex("t_id"),13,4), substr(hex("t_id"),17,4), substr(hex("t_id"),21)))) VIRTUAL,
	`expires` text NOT NULL,
	FOREIGN KEY (`t_id`) REFERENCES `tenants`(`t_id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_tenants_ak_id_t_id_unique` ON `api_keys_tenants` (`ak_id`,`t_id`);--> statement-breakpoint
CREATE TABLE `tenants` (
	`t_id` blob PRIMARY KEY NOT NULL,
	`t_id_utf8` text GENERATED ALWAYS AS (lower(format('%s-%s-%s-%s-%s', substr(hex("t_id"),1,8), substr(hex("t_id"),9,4), substr(hex("t_id"),13,4), substr(hex("t_id"),17,4), substr(hex("t_id"),21)))) VIRTUAL,
	`d1_id` blob NOT NULL,
	`d1_id_utf8` text GENERATED ALWAYS AS (lower(format('%s-%s-%s-%s-%s', substr(hex("d1_id"),1,8), substr(hex("d1_id"),9,4), substr(hex("d1_id"),13,4), substr(hex("d1_id"),17,4), substr(hex("d1_id"),21)))) VIRTUAL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tenants_d1_id_unique` ON `tenants` (`d1_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`u_id` blob PRIMARY KEY NOT NULL,
	`u_id_utf8` text GENERATED ALWAYS AS (lower(format('%s-%s-%s-%s-%s', substr(hex("u_id"),1,8), substr(hex("u_id"),9,4), substr(hex("u_id"),13,4), substr(hex("u_id"),17,4), substr(hex("u_id"),21)))) VIRTUAL,
	`d1_id` blob NOT NULL,
	`d1_id_utf8` text GENERATED ALWAYS AS (lower(format('%s-%s-%s-%s-%s', substr(hex("d1_id"),1,8), substr(hex("d1_id"),9,4), substr(hex("d1_id"),13,4), substr(hex("d1_id"),17,4), substr(hex("d1_id"),21)))) VIRTUAL,
	`email` text NOT NULL,
	`partial_user` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_d1_id_unique` ON `users` (`d1_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `case_insensitive_email` ON `users` (lower("email"));--> statement-breakpoint
CREATE TABLE `users_accounts` (
	`u_id` blob NOT NULL,
	`u_id_utf8` text GENERATED ALWAYS AS (lower(format('%s-%s-%s-%s-%s', substr(hex("u_id"),1,8), substr(hex("u_id"),9,4), substr(hex("u_id"),13,4), substr(hex("u_id"),17,4), substr(hex("u_id"),21)))) VIRTUAL,
	`provider` text NOT NULL,
	`provider_account_id` text NOT NULL,
	PRIMARY KEY(`provider`, `provider_account_id`),
	FOREIGN KEY (`u_id`) REFERENCES `users`(`u_id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `users_sessions` (
	`u_id` blob NOT NULL,
	`u_id_utf8` text GENERATED ALWAYS AS (lower(format('%s-%s-%s-%s-%s', substr(hex("u_id"),1,8), substr(hex("u_id"),9,4), substr(hex("u_id"),13,4), substr(hex("u_id"),17,4), substr(hex("u_id"),21)))) VIRTUAL,
	`s_id` blob PRIMARY KEY NOT NULL,
	`s_id_utf8` text GENERATED ALWAYS AS (lower(format('%s-%s-%s-%s-%s', substr(hex("s_id"),1,8), substr(hex("s_id"),9,4), substr(hex("s_id"),13,4), substr(hex("s_id"),17,4), substr(hex("s_id"),21)))) VIRTUAL,
	`expires` text NOT NULL,
	FOREIGN KEY (`u_id`) REFERENCES `users`(`u_id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `users_tenants` (
	`u_id` blob NOT NULL,
	`u_id_utf8` text GENERATED ALWAYS AS (lower(format('%s-%s-%s-%s-%s', substr(hex("u_id"),1,8), substr(hex("u_id"),9,4), substr(hex("u_id"),13,4), substr(hex("u_id"),17,4), substr(hex("u_id"),21)))) VIRTUAL,
	`t_id` blob NOT NULL,
	`t_id_utf8` text GENERATED ALWAYS AS (lower(format('%s-%s-%s-%s-%s', substr(hex("t_id"),1,8), substr(hex("t_id"),9,4), substr(hex("t_id"),13,4), substr(hex("t_id"),17,4), substr(hex("t_id"),21)))) VIRTUAL,
	FOREIGN KEY (`u_id`) REFERENCES `users`(`u_id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`t_id`) REFERENCES `tenants`(`t_id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_tenants_u_id_t_id_unique` ON `users_tenants` (`u_id`,`t_id`);