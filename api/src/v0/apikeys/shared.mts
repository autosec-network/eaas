import { z } from '@hono/zod-openapi';
import { Permissions } from '~shared/types/d1/index.mjs';

export const apikeyOutput = z
	.object({
		token_id: z.string().trim().nonempty().base64url(),
		name: z.string().trim().nonempty(),
		created: z
			.string()
			.datetime({ precision: 3 })
			.openapi({ example: new Date(0).toISOString() }),
		lastRotation: z
			.string()
			.datetime({ precision: 3 })
			.openapi({ example: new Date(0).toISOString() }),
		expires: z
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
