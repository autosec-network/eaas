import { ml_kem1024, ml_kem512, ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { SQLCache } from 'db/cache';
import { DebugLogWriter, drizzleD0, StaticDatabase } from 'db/core';
import * as rootSchema from 'db/schemas/root';
import * as tenantSchema from 'db/schemas/tenant/main';
import { drizzle } from 'drizzle-orm/d1';
import { DefaultLogger } from 'drizzle-orm/logger';
import { eq, sql } from 'drizzle-orm/sql';
import { ZodUuidInputConverted } from 'helpers/zod/mini';
import { createHash, randomBytes } from 'node:crypto';
import { KeyAlgorithms } from 'types/crypto';
import { v7 as uuidv7 } from 'uuid';
import * as zm from 'zod/mini';
import type { EnvVars } from '~/types.mjs';

// eslint-disable-next-line zod/require-schema-suffix
export const workflowParams = zm.object({
	t_id: ZodUuidInputConverted(7),
	kr_id: ZodUuidInputConverted(7),
});

export class DataKeyRotation extends WorkflowEntrypoint<EnvVars, zm.input<typeof workflowParams>> {
	private static readonly cfApiCallRetry: WorkflowStepConfig = {
		retries: {
			/**
			 * CF global rate limit is 1200/5m
			 * @link https://developers.cloudflare.com/fundamentals/api/reference/limits/
			 */
			delay: 5 * 60 * 1000,
			/**
			 * days * hours * minutes / delay
			 */
			limit: (3 * 24 * 60) / 5,
			backoff: 'constant',
		},
	};
	private static readonly bitwardenCallRetry: WorkflowStepConfig = {
		retries: {
			/**
			 * Bitwarden api rate limit is 500/1m
			 */
			delay: 1 * 60 * 1000,
			/**
			 * days * hours * minutes / delay
			 */
			limit: (3 * 24 * 60) / 1,
			backoff: 'constant',
		},
	};

	override async run(event: Readonly<WorkflowEvent<zm.input<typeof workflowParams>>>, step: WorkflowStep) {
		// First step: always parse params with Zod for validation
		const parsedPayload = await step.do('Parse workflow params', () =>
			workflowParams.safeParseAsync(typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload).then((result) => {
				if (result.success) {
					return result.data;
				} else {
					throw new NonRetryableError(`${result.error.message}: ${zm.prettifyError(result.error)}`);
				}
			}),
		);

		const r_db = drizzle(this.env.DB_ROOT.withSession('first-unconstrained') as unknown as D1Database, {
			// ...(this.env.NODE_ENV !== 'production' && { logger: new DefaultLogger({ writer: new DebugLogWriter(this.env.ENVIRONMENT === 'production' ? StaticDatabase.Root.eaas_root_prod : StaticDatabase.Root.eaas_root_dev) }) }),
			logger: new DefaultLogger({ writer: new DebugLogWriter(this.env.ENVIRONMENT === 'production' ? StaticDatabase.Root.eaas_root_prod : StaticDatabase.Root.eaas_root_dev) }),
			schema: rootSchema,
			casing: 'snake_case',
			cache: new SQLCache({
				dbName: this.env.ENVIRONMENT === 'production' ? StaticDatabase.Root.eaas_root_prod : StaticDatabase.Root.eaas_root_dev,
				dbType: 'd1',
				strategy: 'all',
				cacheTTL: parseInt(this.env.SQL_TTL, 10),
				logging: this.env.NODE_ENV !== 'production',
			}),
		});

		const tenant = await step.do('Tenant DB Lookup', DataKeyRotation.cfApiCallRetry, async () => {
			const [row] = await r_db
				.select({
					jurisdiction: rootSchema.tenants.jurisdiction,
					do_id: rootSchema.tenants.do_id,
				})
				.from(rootSchema.tenants)
				.where(eq(rootSchema.tenants.t_id, sql`unhex(${parsedPayload.t_id.hex})`))
				.limit(1)
				.then((rows) =>
					rows.map((row) => ({
						...row,
						do_id: row.do_id.toString('hex'),
					})),
				);

			if (row) {
				return row;
			} else {
				throw new NonRetryableError('Tenant not found');
			}
		});

		const t_do_id = tenant.jurisdiction ? this.env.TENANT_D0.jurisdiction(tenant.jurisdiction).idFromString(tenant.do_id) : this.env.TENANT_D0.idFromString(tenant.do_id);
		const t_do_stub = this.env.TENANT_D0.get(t_do_id);
		const t_db = drizzleD0(t_do_stub, {
			// ...(this.env.NODE_ENV !== 'production' && { logger: new DefaultLogger({ writer: new DebugLogWriter(row.do_id) }) }),
			logger: new DefaultLogger({ writer: new DebugLogWriter(tenant.do_id) }),
			schema: tenantSchema,
			cache: new SQLCache({
				dbName: tenant.do_id,
				dbType: 'do',
				strategy: 'all',
				cacheTTL: parseInt(this.env.SQL_TTL, 10),
				logging: this.env.NODE_ENV !== 'production',
			}),
		});

		const [dk_id, { key_type, key_size, hash }] = await Promise.all([
			// eslint-disable-next-line @typescript-eslint/require-await
			step.do('Generate datakey ID', async () => {
				const utf8 = uuidv7();
				const hex = utf8.replaceAll('-', '');
				const buffer = Buffer.from(hex, 'hex');

				return {
					utf8,
					hex,
					base64: buffer.toString('base64'),
					base64url: buffer.toString('base64url'),
				};
			}),
			step.do('Get keyring info', DataKeyRotation.cfApiCallRetry, async () => {
				const [row] = await t_db
					.select({
						key_type: tenantSchema.keyrings.key_type,
						key_size: tenantSchema.keyrings.key_size,
						hash: tenantSchema.keyrings.hash,
						generation_versions: tenantSchema.keyrings.generation_versions,
						retreival_versions: tenantSchema.keyrings.retreival_versions,
					})
					.from(tenantSchema.keyrings)
					.where(eq(tenantSchema.keyrings.kr_id, sql`unhex(${parsedPayload.kr_id.hex})`))
					.limit(1);

				if (row) {
					return row;
				} else {
					throw new NonRetryableError('Keyring not found');
				}
			}),
		]);

		/**
		 * @todo delete older versions
		 */

		function generateSalt() {
			const saltBytes = randomBytes(createHash(hash).digest().byteLength);
			return {
				base64: saltBytes.toString('base64'),
				base64url: saltBytes.toString('base64url'),
			};
		}

		function generateMacInfo() {
			const saltBytes = randomBytes(createHash(hash).digest().byteLength);
			return {
				base64: saltBytes.toString('base64'),
				base64url: saltBytes.toString('base64url'),
			};
		}

		// eslint-disable-next-line @typescript-eslint/require-await
		const normalizedHashName = await step.do('Normalize hash', async () => {
			switch (hash) {
				case 'sha1':
				case 'md5-sha1':
				case 'DSA-SHA':
				case 'DSA-SHA1':
				case 'RSA-SHA1':
				case 'ecdsa-with-SHA1':
					return 'SHA-1' as const;
				case 'sha224':
				case 'RSA-SHA224':
					return 'SHA-224' as const;
				case 'sha256':
				case 'RSA-SHA256':
					return 'SHA-256' as const;
				case 'sha384':
				case 'RSA-SHA384':
					return 'SHA-384' as const;
				case 'sha512':
				case 'RSA-SHA512':
					return 'SHA-512' as const;

				default:
					throw new NonRetryableError('Unsupported hash type');
			}
		});

		async function generateKeys(salt_base64: string) {
			switch (key_type) {
				case KeyAlgorithms['RSASSA-PKCS1-v1_5']:
				case KeyAlgorithms['RSA-PSS']:
				case KeyAlgorithms['RSA-OAEP']:
					let normalizedRsaKeySize: undefined | number;
					if (key_size && key_size % 8 === 0) {
						normalizedRsaKeySize = key_size;
					} else {
						// Lets try to infer some defaults
						normalizedRsaKeySize = Buffer.from(salt_base64, 'base64').byteLength * 8 * 8;
					}

					if (normalizedRsaKeySize) {
						let normalizedUsages: readonly KeyUsage[];
						switch (key_type) {
							case KeyAlgorithms['RSASSA-PKCS1-v1_5']:
							case KeyAlgorithms['RSA-PSS']:
								normalizedUsages = ['sign', 'verify'];
								break;
							case KeyAlgorithms['RSA-OAEP']:
								normalizedUsages = ['encrypt', 'decrypt'];
						}

						const keyPair = await crypto.subtle
							.generateKey(
								{
									name: Object.entries(KeyAlgorithms).find((algo) => algo[1] === key_type)![0],
									modulusLength: normalizedRsaKeySize,
									publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
									hash: normalizedHashName,
								} satisfies RsaHashedKeyGenParams,
								true,
								normalizedUsages,
							)
							.catch((err: DOMException) => {
								throw new NonRetryableError(`RSA key generation failed: ${err.message}`);
							});

						return Promise.all([crypto.subtle.exportKey('jwk', keyPair.publicKey), crypto.subtle.exportKey('jwk', keyPair.privateKey)]).then(([publicKey, privateKey]) => ({ publicKey, privateKey }));
					} else {
						throw new NonRetryableError('Missing or bad `key_size`');
					}
				case KeyAlgorithms.ECDSA:
				case KeyAlgorithms.ECDH:
					let normalizedEccCurve: undefined | 'P-256' | 'P-384' | 'P-521';
					switch (key_size) {
						case 256:
							normalizedEccCurve = 'P-256';
							break;
						case 384:
							normalizedEccCurve = 'P-384';
							break;
						case 521:
							normalizedEccCurve = 'P-521';
							break;

						default:
							// Lets try to infer some defaults
							switch (normalizedHashName) {
								case 'SHA-256':
									normalizedEccCurve = 'P-256';
									break;
								case 'SHA-384':
									normalizedEccCurve = 'P-384';
									break;
								case 'SHA-512':
									normalizedEccCurve = 'P-521';
									break;
							}
							break;
					}

					if (normalizedEccCurve) {
						let normalizedUsages: readonly KeyUsage[];
						switch (key_type) {
							case KeyAlgorithms.ECDSA:
								normalizedUsages = ['sign', 'verify'];
								break;
							case KeyAlgorithms.ECDH:
								normalizedUsages = ['deriveBits', 'deriveKey'];
						}

						const keyPair = await crypto.subtle
							.generateKey(
								{
									name: Object.entries(KeyAlgorithms).find((algo) => algo[1] === key_type)![0],
									namedCurve: normalizedEccCurve,
								} satisfies EcKeyGenParams,
								true,
								normalizedUsages,
							)
							.catch((err: DOMException) => {
								throw new NonRetryableError(`ECC key generation failed: ${err.message}`);
							});

						return Promise.all([crypto.subtle.exportKey('jwk', keyPair.publicKey), crypto.subtle.exportKey('jwk', keyPair.privateKey)]).then(([publicKey, privateKey]) => ({ publicKey, privateKey }));
					} else {
						throw new NonRetryableError('Unsupported curve');
					}
				case KeyAlgorithms.HMAC:
					const key = await crypto.subtle
						.generateKey(
							{
								name: Object.entries(KeyAlgorithms).find((algo) => algo[1] === key_type)![0],
								hash: normalizedHashName,
							} satisfies HmacKeyGenParams,
							true,
							['sign', 'verify'],
						)
						.catch((err: DOMException) => {
							throw new NonRetryableError(`HMAC key generation failed: ${err.message}`);
						});

					return crypto.subtle.exportKey('jwk', key).then((privateKey) => ({ publicKey: undefined, privateKey }));
				case KeyAlgorithms['AES-CTR']:
				case KeyAlgorithms['AES-CBC']:
				case KeyAlgorithms['AES-GCM']:
				case KeyAlgorithms['AES-KW']:
					let normalizedAesSize: undefined | 128 | 192 | 256;
					switch (key_size) {
						case 256:
							normalizedAesSize = 128;
							break;
						case 384:
							normalizedAesSize = 192;
							break;
						case 521:
							normalizedAesSize = 256;
							break;

						default:
							// Lets try to infer some defaults
							switch (normalizedHashName) {
								case 'SHA-256':
									normalizedAesSize = 128;
									break;
								case 'SHA-384':
									normalizedAesSize = 192;
									break;
								case 'SHA-512':
									normalizedAesSize = 256;
									break;
							}
							break;
					}

					if (normalizedAesSize) {
						let normalizedUsages: readonly KeyUsage[];
						switch (key_type) {
							case KeyAlgorithms['AES-CTR']:
							case KeyAlgorithms['AES-CBC']:
							case KeyAlgorithms['AES-GCM']:
								normalizedUsages = ['encrypt', 'decrypt'];
								break;
							case KeyAlgorithms['AES-KW']:
								normalizedUsages = ['wrapKey', 'unwrapKey'];
						}

						const key = await crypto.subtle
							.generateKey(
								{
									name: Object.entries(KeyAlgorithms).find((algo) => algo[1] === key_type)![0],
									length: normalizedAesSize,
								} satisfies AesKeyGenParams,
								true,
								normalizedUsages,
							)
							.catch((err: DOMException) => {
								throw new NonRetryableError(`AES key generation failed: ${err.message}`);
							});

						return crypto.subtle.exportKey('jwk', key).then((privateKey) => ({ publicKey: undefined, privateKey }));
					} else {
						throw new NonRetryableError('Unsupported curve');
					}
				case KeyAlgorithms.Ed25519:
				case KeyAlgorithms.X25519:
					let normalizedUsages: KeyUsage[];
					switch (key_type) {
						case KeyAlgorithms.Ed25519:
							normalizedUsages = ['sign', 'verify'];
							break;
						case KeyAlgorithms.X25519:
							normalizedUsages = ['deriveBits'];
					}

					const keyPair = (await crypto.subtle
						.generateKey(
							{
								name: Object.entries(KeyAlgorithms).find((algo) => algo[1] === key_type)![0],
							},
							true,
							normalizedUsages,
						)
						.catch((err: DOMException) => {
							throw new NonRetryableError(`Ed25519/X25519 key generation failed: ${err.message}`);
						})) as CryptoKeyPair;

					return Promise.all([crypto.subtle.exportKey('jwk', keyPair.publicKey), crypto.subtle.exportKey('jwk', keyPair.privateKey)]).then(([publicKey, privateKey]) => ({ publicKey, privateKey }));
				case KeyAlgorithms['ML-KEM']:
					let normalizedMlkemKeySize: undefined | 512 | 768 | 1024;
					switch (key_size) {
						case 512:
						case 768:
						case 1024:
							normalizedMlkemKeySize = key_size;
							break;

						default:
							// Lets try to infer some defaults
							switch (normalizedHashName) {
								case 'SHA-1':
								case 'SHA-224':
								case 'SHA-256':
									normalizedMlkemKeySize = 512;
									break;
								case 'SHA-384':
									normalizedMlkemKeySize = 768;
									break;
								case 'SHA-512':
									normalizedMlkemKeySize = 1024;
									break;
							}
							break;
					}

					if (normalizedMlkemKeySize) {
						return (async () => {
							switch (normalizedMlkemKeySize) {
								case 512:
									return ml_kem512;
								case 768:
									return ml_kem768;
								case 1024:
									return ml_kem1024;
							}
						})().then((ml_kem) => {
							const { publicKey, secretKey } = ml_kem.keygen();
							const { cipherText } = ml_kem.encapsulate(publicKey);

							return {
								publicKey: {
									kty: 'LWE',
									key_ops: ['encrypt'],
									alg: `ML-KEM${normalizedMlkemKeySize}`,
									crv: 'CRYSTALS-Kyber',
									ext: true,
									x: Buffer.from(cipherText).toString('base64url'),
								} as JsonWebKey,
								privateKey: {
									kty: 'LWE',
									key_ops: ['decrypt'],
									alg: `ML-KEM${normalizedMlkemKeySize}`,
									crv: 'CRYSTALS-Kyber',
									ext: true,
									x: Buffer.from(cipherText).toString('base64url'),
									d: Buffer.from(secretKey).toString('base64url'),
								} as JsonWebKey,
							};
						});
					} else {
						throw new NonRetryableError('Unsupported key size');
					}

				default:
					throw new NonRetryableError('Unsupported key type');
			}
		}
	}
}
