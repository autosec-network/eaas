import * as zm from 'zod/mini';
import * as z4 from 'zod/v4';
import { PropertiesSchema, PropertiesSchema4 } from '../index.js';

export const TenantPropertiesSchema = zm.extend(PropertiesSchema, {
	avatar: zm.nullish(zm.url({ protocol: /^https$/, hostname: zm.regexes.domain }).check(zm.trim())),
	name: zm.string().check(zm.trim(), zm.minLength(1)),
	/**
	 * UUID of tenant's byo bw secret on root bw
	 */
	byo_bw: zm.nullish(zm.uuidv4().check(zm.trim())),
});
export const TenantPropertiesSchema4 = PropertiesSchema4.extend({
	avatar: z4
		.url({ protocol: /^https$/, hostname: z4.regexes.domain })
		.trim()
		.nullish(),
	name: z4.string().trim().nonempty(),
	/**
	 * UUID of tenant's byo bw secret on root bw
	 */
	byo_bw: z4.uuidv4().trim().nullish(),
});

export const TenantByoBwNoteSchema = zm.object({
	project: zm.uuidv4().check(zm.trim()),
	endpoints: zm.object({
		/**
		 * @link https://bitwarden.com/help/public-api/#base-url
		 */
		base: zm.url({ protocol: /^https$/, hostname: zm.regexes.domain, normalize: true }),
		/**
		 * @link https://bitwarden.com/help/public-api/#authentication-endpoints
		 */
		authentication: zm.url({ protocol: /^https$/, hostname: zm.regexes.domain, normalize: true }),
	}),
});
// eslint-disable-next-line zod/require-schema-suffix
export const TenantByoBwNoteSchema4 = z4.object({
	project: z4.uuidv4().trim(),
	endpoints: z4.object({
		/**
		 * @link https://bitwarden.com/help/public-api/#base-url
		 */
		base: z4.url({ protocol: /^https$/, hostname: z4.regexes.domain, normalize: true }),
		/**
		 * @link https://bitwarden.com/help/public-api/#authentication-endpoints
		 */
		authentication: z4.url({ protocol: /^https$/, hostname: z4.regexes.domain, normalize: true }),
	}),
});
