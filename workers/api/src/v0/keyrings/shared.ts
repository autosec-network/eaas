import { z } from '@hono/zod-openapi';
import cron from 'cron-validate';
import { KeyAlgorithms } from 'types/crypto';
import { workersCryptoCatalog } from 'types/crypto/catalog';

const timeEditable = z.object({
	enabled: z.boolean(),
	cron: z.array(
		z
			.string()
			.trim()
			.nonempty()
			.default('0 0 1 1 *')
			/**
			 * @link https://github.com/P4sca1/cron-schedule?tab=readme-ov-file#cron-validation
			 */
			.refine((value) => cron(value, { preset: 'npm-cron-schedule' }).isValid()),
	),
});

const countEditable = z.object({
	enabled: z.boolean(),
	threshold: z.coerce
		.bigint()
		.default((BigInt(2) ** BigInt(32)).toString() as unknown as bigint)
		.nullable(),
});
const rotationEditable = z.object({
	time: timeEditable,
	count: countEditable,
});

const keyringAlgorithm = (() => {
	const rsaBase = z.object({
		algorithm: z.enum([KeyAlgorithms['RSASSA-PKCS1-v1_5'], KeyAlgorithms['RSA-PSS'], KeyAlgorithms['RSA-OAEP']]),
		size: z
			.int()
			.gte(256)
			.lte(16 * 1024)
			.multipleOf(8),
		hash: z.enum(workersCryptoCatalog.hashes),
	});
	const ecBase = z.object({
		algorithm: z.enum([KeyAlgorithms.ECDSA, KeyAlgorithms.ECDH]),
		size: z.union([z.literal(256), z.literal(384), z.literal(521)]),
		hash: z.enum(workersCryptoCatalog.hashes),
	});
	const aesBase = z.object({
		algorithm: z.enum([KeyAlgorithms['AES-CTR'], KeyAlgorithms['AES-CBC'], KeyAlgorithms['AES-GCM'], KeyAlgorithms['AES-KW']]),
		size: z.union([z.literal(128), z.literal(192), z.literal(256)]),
		hash: z.enum(workersCryptoCatalog.hashes),
	});
	const mlkemBase = z.object({
		algorithm: z.literal(KeyAlgorithms['ML-KEM']),
		size: z.union([z.literal(512), z.literal(768), z.literal(1024)]),
		hash: z.enum(workersCryptoCatalog.hashes),
	});
	const mldsaBase = z.object({
		algorithm: z.literal(KeyAlgorithms['ML-DSA']),
		size: z.union([z.literal(44), z.literal(65), z.literal(87)]),
		hash: z.enum(workersCryptoCatalog.hashes),
	});
	const slhdsaBase = z.object({
		algorithm: z.enum([KeyAlgorithms['SLH-DSA-SHA2-S'], KeyAlgorithms['SLH-DSA-SHA2-F'], KeyAlgorithms['SLH-DSA-SHAKE-S'], KeyAlgorithms['SLH-DSA-SHAKE-F']]),
		size: z.union([z.literal(128), z.literal(192), z.literal(256)]),
		hash: z.enum(workersCryptoCatalog.hashes),
	});
	const falconBase = z.object({
		algorithm: z.literal(KeyAlgorithms.Falcon),
		size: z.union([z.literal(512), z.literal(1024)]),
		hash: z.enum(workersCryptoCatalog.hashes),
	});

	return z.union([
		z.union([
			rsaBase,
			rsaBase.extend({
				size: z
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
			ecBase,
			ecBase.extend({
				size: z.union([z.literal(256), z.literal(384), z.literal(521)]).default(256),
				hash: z.enum(['sha256', 'RSA-SHA256'] satisfies (typeof workersCryptoCatalog.hashes)[number][]),
			}),
			ecBase.extend({
				size: z.union([z.literal(256), z.literal(384), z.literal(521)]).default(384),
				hash: z.enum(['sha384', 'RSA-SHA384'] satisfies (typeof workersCryptoCatalog.hashes)[number][]),
			}),
			ecBase.extend({
				size: z.union([z.literal(256), z.literal(384), z.literal(521)]).default(521),
				hash: z.enum(['sha512', 'RSA-SHA512'] satisfies (typeof workersCryptoCatalog.hashes)[number][]),
			}),
		]),
		z.object({
			algorithm: z.literal(KeyAlgorithms.HMAC),
			hash: z.enum(workersCryptoCatalog.hashes),
		}),
		z.union([
			aesBase,
			aesBase.extend({
				size: z.union([z.literal(128), z.literal(192), z.literal(256)]).default(128),
				hash: z.enum(['sha256', 'RSA-SHA256'] satisfies (typeof workersCryptoCatalog.hashes)[number][]),
			}),
			aesBase.extend({
				size: z.union([z.literal(128), z.literal(192), z.literal(256)]).default(192),
				hash: z.enum(['sha384', 'RSA-SHA384'] satisfies (typeof workersCryptoCatalog.hashes)[number][]),
			}),
			aesBase.extend({
				size: z.union([z.literal(128), z.literal(192), z.literal(256)]).default(256),
				hash: z.enum(['sha512', 'RSA-SHA512'] satisfies (typeof workersCryptoCatalog.hashes)[number][]),
			}),
		]),
		z.object({
			algorithm: z.enum([KeyAlgorithms.Ed25519, KeyAlgorithms.X25519]),
			hash: z.enum(workersCryptoCatalog.hashes),
		}),
		z.union([
			mlkemBase,
			mlkemBase.extend({
				size: z.union([z.literal(512), z.literal(768), z.literal(1024)]).default(512),
				hash: z.enum(['sha256', 'RSA-SHA256'] satisfies (typeof workersCryptoCatalog.hashes)[number][]),
			}),
			mlkemBase.extend({
				size: z.union([z.literal(512), z.literal(768), z.literal(1024)]).default(768),
				hash: z.enum(['sha384', 'RSA-SHA384'] satisfies (typeof workersCryptoCatalog.hashes)[number][]),
			}),
			mlkemBase.extend({
				size: z.union([z.literal(512), z.literal(768), z.literal(1024)]).default(1024),
				hash: z.enum(['sha512', 'RSA-SHA512'] satisfies (typeof workersCryptoCatalog.hashes)[number][]),
			}),
		]),
		z.union([
			mldsaBase,
			mldsaBase.extend({
				size: z.union([z.literal(44), z.literal(65), z.literal(87)]).default(44),
				hash: z.enum(['sha256', 'RSA-SHA256'] satisfies (typeof workersCryptoCatalog.hashes)[number][]),
			}),
			mldsaBase.extend({
				size: z.union([z.literal(44), z.literal(65), z.literal(87)]).default(65),
				hash: z.enum(['sha384', 'RSA-SHA384'] satisfies (typeof workersCryptoCatalog.hashes)[number][]),
			}),
			mldsaBase.extend({
				size: z.union([z.literal(44), z.literal(65), z.literal(87)]).default(87),
				hash: z.enum(['sha512', 'RSA-SHA512'] satisfies (typeof workersCryptoCatalog.hashes)[number][]),
			}),
		]),
		z.union([
			slhdsaBase,
			slhdsaBase.extend({
				size: z.union([z.literal(128), z.literal(192), z.literal(256)]).default(128),
				hash: z.enum(['sha256', 'RSA-SHA256'] satisfies (typeof workersCryptoCatalog.hashes)[number][]),
			}),
			slhdsaBase.extend({
				size: z.union([z.literal(128), z.literal(192), z.literal(256)]).default(192),
				hash: z.enum(['sha384', 'RSA-SHA384'] satisfies (typeof workersCryptoCatalog.hashes)[number][]),
			}),
			slhdsaBase.extend({
				size: z.union([z.literal(128), z.literal(192), z.literal(256)]).default(256),
				hash: z.enum(['sha512', 'RSA-SHA512'] satisfies (typeof workersCryptoCatalog.hashes)[number][]),
			}),
		]),
		z.union([
			falconBase,
			falconBase.extend({
				size: z.union([z.literal(512), z.literal(1024)]).default(512),
				hash: z.enum(['sha1', 'DSA-SHA', 'DSA-SHA1', 'RSA-SHA1', 'sha224', 'RSA-SHA224', 'sha256', 'RSA-SHA256', 'sha384', 'RSA-SHA384'] satisfies (typeof workersCryptoCatalog.hashes)[number][]),
			}),
			falconBase.extend({
				size: z.union([z.literal(512), z.literal(1024)]).default(1024),
				hash: z.enum(['sha512', 'RSA-SHA512'] satisfies (typeof workersCryptoCatalog.hashes)[number][]),
			}),
		]),
	]);
})();

export const keyringEditable = z.object({
	name: z.string(),
	key: keyringAlgorithm,
	rotation: rotationEditable,
});

export const keyringOutput = keyringEditable.extend({
	created: z.iso.datetime({ precision: 3 }).openapi({ example: new Date(0).toISOString() }),
	lastModified: z.iso.datetime({ precision: 3 }).openapi({ example: new Date(0).toISOString() }),
	rotation: rotationEditable.extend({
		lastRotation: z.iso.datetime({ precision: 3 }).openapi({ example: new Date(0).toISOString() }),
		time: timeEditable.extend({
			next: z.iso
				.datetime({ precision: 3 })
				.nullable()
				.openapi({ example: new Date(0).toISOString() }),
		}),
		count: countEditable.extend({
			current: z.coerce.bigint().openapi({ example: BigInt(0).toString() }),
		}),
	}),
});
