import { z } from '@hono/zod-openapi';

const timeEditable = await import('cron-validate').then(({ default: cron }) =>
	z.object({
		enabled: z.boolean(),
		cron: z.array(
			z
				.string()
				.trim()
				.nonempty()
				/**
				 * @link https://github.com/P4sca1/cron-schedule?tab=readme-ov-file#cron-validation
				 */
				.refine((value) => cron(value, { preset: 'npm-cron-schedule' }).isValid())
				.default('0 0 1 1 *'),
		),
	}),
);
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

const keyringAlgorithm = await Promise.all([import('~shared/types/crypto/index.mjs'), import('~shared/types/crypto/workers-crypto-catalog.mjs')]).then(([{ KeyAlgorithms }, { workersCryptoCatalog }]) => {
	const rsaBase = z.object({
		algorithm: z.enum([KeyAlgorithms['RSASSA-PKCS1-v1_5'], KeyAlgorithms['RSA-PSS'], KeyAlgorithms['RSA-OAEP']]),
	});
	const ecBase = z.object({
		algorithm: z.enum([KeyAlgorithms.ECDSA, KeyAlgorithms.ECDH]),
	});

	return z.union([
		z.union([
			rsaBase.extend({
				size: z
					.number()
					.int()
					.gte(256)
					.lte(16 * 1024)
					.multipleOf(8)
					// sha1 character length * 8 byte * 8 bit
					.default(20 * 8 * 8),
				hash: z.enum(['sha1', 'md5-sha1', 'DSA-SHA1', 'RSA-SHA1', 'ecdsa-with-SHA1'] satisfies (typeof workersCryptoCatalog.hashes)[number][]),
			}),
			rsaBase.extend({
				size: z
					.number()
					.int()
					.gte(256)
					.lte(16 * 1024)
					.multipleOf(8)
					// sha256 character length * 8 byte * 8 bit
					.default(32 * 8 * 8),
				hash: z.enum(['sha256', 'RSA-SHA256'] satisfies (typeof workersCryptoCatalog.hashes)[number][]),
			}),
			rsaBase.extend({
				size: z
					.number()
					.int()
					.gte(256)
					.lte(16 * 1024)
					.multipleOf(8)
					// sha256 character length * 8 byte * 8 bit
					.default(48 * 8 * 8),
				hash: z.enum(['sha384', 'RSA-SHA384'] satisfies (typeof workersCryptoCatalog.hashes)[number][]),
			}),
			rsaBase.extend({
				size: z
					.number()
					.int()
					.gte(256)
					.lte(16 * 1024)
					.multipleOf(8)
					// sha512 character length * 8 byte * 8 bit
					.default(64 * 8 * 8),
				hash: z.enum(['sha512', 'RSA-SHA512'] satisfies (typeof workersCryptoCatalog.hashes)[number][]),
			}),
		]),
		z.union([
			ecBase.extend({
				size: z.literal(256),
				hash: z.enum(['sha256', 'RSA-SHA256'] satisfies (typeof workersCryptoCatalog.hashes)[number][]),
			}),
			ecBase.extend({
				size: z.literal(384),
				hash: z.enum(['sha384', 'RSA-SHA384'] satisfies (typeof workersCryptoCatalog.hashes)[number][]),
			}),
			ecBase.extend({
				size: z.literal(521),
				hash: z.enum(['sha512', 'RSA-SHA512'] satisfies (typeof workersCryptoCatalog.hashes)[number][]),
			}),
		]),
		z.object({
			algorithm: z.literal(KeyAlgorithms.HMAC),
			hash: z.enum(workersCryptoCatalog.hashes),
		}),
	]);
});

export const keyringEditable = z
	.object({
		name: z.string(),
		key: keyringAlgorithm,
		rotation: rotationEditable,
	})
	.openapi('KeyringsEditable');

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
