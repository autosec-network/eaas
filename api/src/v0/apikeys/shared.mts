import { z } from '@hono/zod-openapi';
import { Permissions } from '~shared/types/d1/index.mjs';

const apikeyPermissions = z
	.object({
		/**
		 * 1. Can see all datakeys
		 * 2. Can rotate
		 * 3. Can prune datakeys
		 * @note None show the actual key
		 */
		r_datakeys: z.nativeEnum(Permissions).optional().default(Permissions.Read).describe('Datakey management permissions'),
		/**
		 * Encrypt data
		 */
		r_encrypt: z.boolean().optional().default(true).describe('Allow encryption operations'),
		/**
		 * Decrypt data
		 */
		r_decrypt: z.boolean().optional().default(false).describe('Allow decryption operations'),
		/**
		 * Rewrap data
		 */
		r_rewrap: z.boolean().optional().default(true).describe('Allow rewrap operations'),
		/**
		 * Sign data
		 */
		r_sign: z.boolean().optional().default(true).describe('Allow signing operations'),
		/**
		 * Verify signed data
		 */
		r_verify: z.boolean().optional().default(true).describe('Allow signature verification'),
		/**
		 * Generate HMAC
		 */
		r_hmac: z.boolean().optional().default(true).describe('Allow HMAC operations'),
	})
	.describe('Permissions for the API key');

export const apikeyEditable = z
	.object({
		name: z.string().trim().nonempty().describe('Name for the API key'),
		kr_id: z.string().trim().nonempty().base64url().describe('Keyring ID (base64url encoded)'),
		expires: z
			.string()
			.datetime({ precision: 3 })
			.optional()
			.describe('Expiration date and time. Defaults to 90 days from now')
			.openapi({ example: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString() }),
		permissions: apikeyPermissions.optional().default({}),
	})
	.openapi('ApikeyEditable');

export const apikeyOutput = apikeyEditable
	.omit({ kr_id: true, permissions: true })
	.extend({
		token_id: z.string().trim().nonempty().base64url(),
		created: z
			.string()
			.datetime({ precision: 3 })
			.openapi({ example: new Date(0).toISOString() }),
		lastRotation: z
			.string()
			.datetime({ precision: 3 })
			.openapi({ example: new Date(0).toISOString() }),
		expired: z.boolean(),
		lastModified: z
			.string()
			.datetime({ precision: 3 })
			.openapi({ example: new Date(0).toISOString() }),
		// @ts-expect-error First half of `enum` object is the nice name
		keyringsPermission: z.enum(Object.values(Permissions).slice(0, Math.ceil(Object.values(Permissions).length / 2))),
		// @ts-expect-error First half of `enum` object is the nice name
		apikeysPermission: z.enum(Object.values(Permissions).slice(0, Math.ceil(Object.values(Permissions).length / 2))),
	})
	.openapi('ApikeyOutput');

export const createApikeyOutput = apikeyOutput
	.extend({
		token: z.string().trim().nonempty().describe('The generated API token (Bearer format)'),
	})
	.openapi('CreateApikeyOutput');
