import { z } from '@hono/zod-openapi';
import { Permissions } from 'types';

const apikeyPermissions = z
	.object({
		/**
		 * 1. Can see all datakeys
		 * 2. Can rotate
		 * 3. Can prune datakeys
		 * @note None show the actual key
		 */
		r_datakeys: z
			// @ts-expect-error First half of `enum` object is the nice name
			.enum(Object.values(Permissions).slice(0, Math.ceil(Object.values(Permissions).length / 2)))
			.default(Permissions[Permissions.Read])
			.transform((value) => Permissions[value as keyof typeof Permissions]),
		/**
		 * Encrypt data
		 */
		r_encrypt: z.boolean().default(true),
		/**
		 * Decrypt data
		 */
		r_decrypt: z.boolean().default(false),
		/**
		 * Rewrap data
		 */
		r_rewrap: z.boolean().default(true),
		/**
		 * Sign data
		 */
		r_sign: z.boolean().default(true),
		/**
		 * Verify signed data
		 */
		r_verify: z.boolean().default(true),
		/**
		 * Generate HMAC
		 */
		r_hmac: z.boolean().default(true),
	})
	.describe('Permissions for the API key');

export const apikeyEditable = z.object({
	name: z.string().trim().nonempty().describe('Name for the API key'),
	expires: z.iso
		.datetime({ precision: 3 })
		.nullish()
		.describe('Expiration date and time. Defaults to 90 days from now')
		.openapi({ example: new Date(0).toISOString() }),
	keyringsPermission: z
		// @ts-expect-error First half of `enum` object is the nice name
		.enum(Object.values(Permissions).slice(0, Math.ceil(Object.values(Permissions).length / 2)))
		.default(Permissions[Permissions.None])
		.transform((value) => Permissions[value as keyof typeof Permissions]),
	apikeysPermission: z
		// @ts-expect-error First half of `enum` object is the nice name
		.enum(Object.values(Permissions).slice(0, Math.ceil(Object.values(Permissions).length / 2)))
		.default(Permissions[Permissions.None])
		.transform((value) => Permissions[value as keyof typeof Permissions]),
	keyrings: z.record(z.string().trim().nonempty(), apikeyPermissions).default({}),
});

export const apikeyOutput = apikeyEditable.extend({
	token_id: z.base64url().trim().length(22).nonempty(),
	created: z.iso.datetime({ precision: 3 }).openapi({ example: new Date(0).toISOString() }),
	lastRotation: z.iso.datetime({ precision: 3 }).openapi({ example: new Date(0).toISOString() }),
	expired: z.boolean(),
	lastModified: z.iso.datetime({ precision: 3 }).openapi({ example: new Date(0).toISOString() }),
	enabled: z.boolean().describe('Whether the API key is active. A disabled key fails authentication without being deleted'),
});

export const createApikeyOutput = apikeyOutput.extend({
	token: z.string().trim().nonempty().describe('The generated API token'),
});
