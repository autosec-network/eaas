import { z } from '@hono/zod-openapi';
import { Permissions } from '~shared/types/d1/index.mjs';

export const apikeyOutput = z
	.object({
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
		keyringsPermission: z.nativeEnum(Permissions),
		apikeysPermission: z.nativeEnum(Permissions),
	})
	.openapi('ApikeyOutput');
