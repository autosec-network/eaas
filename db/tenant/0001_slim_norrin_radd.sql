ALTER TABLE `api_keys` ADD `r_keyrings` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `api_keys` ADD `r_apikeys` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `api_keys_keyrings` ADD `r_datakeys` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `api_keys_keyrings` DROP COLUMN `r_random`;--> statement-breakpoint
ALTER TABLE `api_keys_keyrings` DROP COLUMN `r_hash`;