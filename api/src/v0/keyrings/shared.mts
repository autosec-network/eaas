import { z } from '@hono/zod-openapi';

const timeEditable = z.object({
	enabled: z.boolean(),
	cron: z.array(z.string()),
});
const countEditable = z.object({
	enabled: z.boolean(),
	threshold: z
		.bigint()
		.nullable()
		.openapi({ example: BigInt(0).toString() as unknown as bigint }),
});
const rotationEditable = z.object({
	time: timeEditable,
	count: countEditable,
});

export const keyringEditable = await Promise.all([import('~shared/types/crypto/index.mjs'), import('~shared/types/crypto/workers-crypto-catalog.mjs')]).then(([{ KeyAlgorithms }, { workersCryptoCatalog }]) => {
	return z
		.object({
			name: z.string(),
			key: z.object({
				algorithm: z.nativeEnum(KeyAlgorithms),
				size: z.number().int().nullable(),
				hash: z.enum(workersCryptoCatalog.hashes),
			}),
			rotation: rotationEditable,
		})
		.openapi('KeyringsEditable');
});

export const keyringOutput = keyringEditable
	.extend({
		created: z
			.string()
			.datetime({ precision: 3 })
			.openapi({ example: new Date(0).toISOString() }),
		lastModified: z
			.string()
			.datetime({ precision: 3 })
			.openapi({ example: new Date(0).toISOString() }),
		rotation: rotationEditable.extend({
			lastRotation: z
				.string()
				.datetime({ precision: 3 })
				.openapi({ example: new Date(0).toISOString() }),
			time: timeEditable.extend({
				next: z
					.string()
					.datetime({ precision: 3 })
					.nullable()
					.openapi({ example: new Date(0).toISOString() }),
			}),
			count: countEditable.extend({
				current: z.bigint().openapi({ example: BigInt(0).toString() as unknown as bigint }),
			}),
		}),
	})
	.openapi('KeyringsOutput');
