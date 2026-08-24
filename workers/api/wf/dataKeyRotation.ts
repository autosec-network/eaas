import { falcon1024, falcon512 } from '@noble/post-quantum/falcon.js';
import { ml_dsa44, ml_dsa65, ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem1024, ml_kem512, ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { slh_dsa_sha2_128f, slh_dsa_sha2_128s, slh_dsa_sha2_192f, slh_dsa_sha2_192s, slh_dsa_sha2_256f, slh_dsa_sha2_256s, slh_dsa_shake_128f, slh_dsa_shake_128s, slh_dsa_shake_192f, slh_dsa_shake_192s, slh_dsa_shake_256f, slh_dsa_shake_256s } from '@noble/post-quantum/slh-dsa.js';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { TenantByoBwNoteSchema } from 'db';
import { SQLCache } from 'db/cache';
import { DebugLogWriter, drizzleD0, StaticDatabase } from 'db/core';
import * as rootSchema from 'db/schemas/root';
import * as tenantSchema from 'db/schemas/tenant/main';
import { drizzle } from 'drizzle-orm/d1';
import { DefaultLogger } from 'drizzle-orm/logger';
import { eq, sql } from 'drizzle-orm/sql';
import { DataKeyRotationParamsSchema } from 'helpers/zod/mini';
import { createHash, randomBytes } from 'node:crypto';
import { DOJurisdictions } from 'types';
import { BitwardenCloudEndpoints } from 'types/bw';
import { KeyAlgorithms } from 'types/crypto';
import { TenantLogEventStatus, TenantLogEventType, TenantLogQueueMessageSchema } from 'types/tenants/logging';
import { v7 as uuidv7 } from 'uuid';
import * as zm from 'zod/mini';
import { openBitwardenSession as openPooledBitwardenSession } from '~/bitwarden-pool';
import type { EnvVars } from '~/types';

export const workflowParams = DataKeyRotationParamsSchema;

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
			delay: ({ error }) => {
				// Bitwarden api rate limit is 500/1m (1 * 60 * 1000)
				const bitwardenBaseDelayMs = 60_000 as const;

				try {
					/**
					 * BitwardenSession (do/BitwardenSession.ts) throws errors whose `message` is a JSON blob carrying the raw Bitwarden response `headers`. If the `x-rate-limit-reset` header is present, wait until then instead of the base delay whenever that's the longer of the two.
					 */
					const headers = new Headers((JSON.parse(error.message) as { headers?: Record<string, string> }).headers);
					const reset = headers.get('x-rate-limit-reset');
					if (reset) {
						const msUntilReset = new Date(reset).getTime() - Date.now();
						return Math.max(bitwardenBaseDelayMs, msUntilReset);
					}
					// eslint-disable-next-line @typescript-eslint/no-unused-vars
				} catch (_err) {
					// error.message wasn't a BitwardenSession API error payload (e.g. a network error) - fall back to the base delay
				}

				return bitwardenBaseDelayMs;
			},
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
			cache: new SQLCache({
				dbName: tenant.do_id,
				dbType: 'do',
				strategy: 'all',
				cacheTTL: parseInt(this.env.SQL_TTL, 10),
				logging: this.env.NODE_ENV !== 'production',
			}),
		});

		const [dk_id, { key_type, key_size, hash }, byo_bw] = await Promise.all([
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
			step.do('Get bitwarden connection info', DataKeyRotation.cfApiCallRetry, async () => t_do_stub.getProperties({ byo_bw: true }).then(({ byo_bw }) => byo_bw)),
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
				case KeyAlgorithms['RSA-OAEP']: {
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
				}
				case KeyAlgorithms.ECDSA:
				case KeyAlgorithms.ECDH: {
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
								case 'SHA-1':
								case 'SHA-224':
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
						case 128:
						case 192:
						case 256:
							normalizedAesSize = key_size;
							break;

						default:
							// Lets try to infer some defaults
							switch (normalizedHashName) {
								case 'SHA-1':
								case 'SHA-224':
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
						const { publicKey, secretKey } = (() => {
							switch (normalizedMlkemKeySize) {
								case 512:
									return ml_kem512;
								case 768:
									return ml_kem768;
								case 1024:
									return ml_kem1024;
							}
						})().keygen();

						/**
						 * @link https://datatracker.ietf.org/doc/draft-ietf-jose-pqc-kem/
						 * v5
						 */
						return {
							publicKey: {
								kty: 'AKP',
								alg: `ML-KEM${normalizedMlkemKeySize}`,
								pub: Buffer.from(publicKey).toString('base64url'),
							} as JsonWebKey,
							privateKey: {
								kty: 'AKP',
								alg: `ML-KEM${normalizedMlkemKeySize}`,
								pub: Buffer.from(publicKey).toString('base64url'),
								priv: Buffer.from(secretKey).toString('base64url'),
							} as JsonWebKey,
						};
					} else {
						throw new NonRetryableError('Unsupported key size');
					}
				case KeyAlgorithms['ML-DSA']:
					let normalizedMldsaKeySize: undefined | 44 | 65 | 87;
					switch (key_size) {
						case 44:
						case 65:
						case 87:
							normalizedMldsaKeySize = key_size;
							break;

						default:
							// Lets try to infer some defaults
							switch (normalizedHashName) {
								case 'SHA-1':
								case 'SHA-224':
								case 'SHA-256':
									normalizedMldsaKeySize = 44;
									break;
								case 'SHA-384':
									normalizedMldsaKeySize = 65;
									break;
								case 'SHA-512':
									normalizedMldsaKeySize = 87;
									break;
							}
							break;
					}

					if (normalizedMldsaKeySize) {
						const seed = crypto.getRandomValues(new Uint8Array(256 / 8));
						const { publicKey } = (() => {
							switch (normalizedMldsaKeySize) {
								case 44:
									return ml_dsa44;
								case 65:
									return ml_dsa65;
								case 87:
									return ml_dsa87;
							}
						})().keygen(seed);
						const kid = createHash('sha256')
							.update(
								JSON.stringify({
									alg: `ML-DSA${normalizedMldsaKeySize}`,
									kty: 'AKP',
									pub: Buffer.from(publicKey).toString('base64url'),
								}),
							)
							.digest('base64url');

						/**
						 * @link https://datatracker.ietf.org/doc/draft-ietf-cose-dilithium/
						 * v11
						 */
						return {
							publicKey: {
								kty: 'AKP',
								alg: `ML-DSA${normalizedMldsaKeySize}`,
								kid,
								pub: Buffer.from(publicKey).toString('base64url'),
							} as JsonWebKey,
							privateKey: {
								kty: 'AKP',
								alg: `ML-DSA${normalizedMldsaKeySize}`,
								kid,
								pub: Buffer.from(publicKey).toString('base64url'),
								priv: Buffer.from(seed).toString('base64url'),
							} as JsonWebKey,
						};
					} else {
						throw new NonRetryableError('Unsupported key size');
					}
				case KeyAlgorithms['SLH-DSA-SHA2-S']:
				case KeyAlgorithms['SLH-DSA-SHA2-F']:
				case KeyAlgorithms['SLH-DSA-SHAKE-S']:
				case KeyAlgorithms['SLH-DSA-SHAKE-F']:
					let normalizedSlhdsaKeySize: undefined | 128 | 192 | 256;
					switch (key_size) {
						case 128:
						case 192:
						case 256:
							normalizedSlhdsaKeySize = key_size;
							break;

						default:
							// Lets try to infer some defaults
							switch (normalizedHashName) {
								case 'SHA-1':
								case 'SHA-224':
								case 'SHA-256':
									normalizedSlhdsaKeySize = 128;
									break;
								case 'SHA-384':
									normalizedSlhdsaKeySize = 192;
									break;
								case 'SHA-512':
									normalizedSlhdsaKeySize = 256;
									break;
							}
							break;
					}

					if (normalizedSlhdsaKeySize) {
						const fragments = key_type.split('-') as ['slh', 'dsa', 'sha2' | 'shake', 's' | 'f'];

						// expected seed is 3/8 of the hash size used
						const seed = crypto.getRandomValues(new Uint8Array(normalizedSlhdsaKeySize * 0.375));
						const { publicKey } = (() => {
							switch (fragments[2]) {
								case 'sha2':
									switch (fragments[3]) {
										case 's':
											switch (normalizedSlhdsaKeySize) {
												case 128:
													return slh_dsa_sha2_128s;
												case 192:
													return slh_dsa_sha2_192s;
												case 256:
													return slh_dsa_sha2_256s;
											}
										// eslint-disable-next-line no-fallthrough
										case 'f':
											switch (normalizedSlhdsaKeySize) {
												case 128:
													return slh_dsa_sha2_128f;
												case 192:
													return slh_dsa_sha2_192f;
												case 256:
													return slh_dsa_sha2_256f;
											}
									}

								// eslint-disable-next-line no-fallthrough
								case 'shake':
									switch (fragments[3]) {
										case 's':
											switch (normalizedSlhdsaKeySize) {
												case 128:
													return slh_dsa_shake_128s;
												case 192:
													return slh_dsa_shake_192s;
												case 256:
													return slh_dsa_shake_256s;
											}
										// eslint-disable-next-line no-fallthrough
										case 'f':
											switch (normalizedSlhdsaKeySize) {
												case 128:
													return slh_dsa_shake_128f;
												case 192:
													return slh_dsa_shake_192f;
												case 256:
													return slh_dsa_shake_256f;
											}
									}
							}
						})().keygen(seed);

						/**
						 * @link https://datatracker.ietf.org/doc/draft-ietf-cose-sphincs-plus/
						 * v7
						 */
						return {
							publicKey: {
								kty: 'AKP',
								alg: `SLH-DSA-${fragments[2].toUpperCase()}-${normalizedSlhdsaKeySize}-${fragments[3].toUpperCase()}`,
								pub: Buffer.from(publicKey).toString('base64url'),
							} as JsonWebKey,
							privateKey: {
								kty: 'AKP',
								alg: `SLH-DSA-${fragments[2].toUpperCase()}-${normalizedSlhdsaKeySize}-${fragments[3].toUpperCase()}`,
								pub: Buffer.from(publicKey).toString('base64url'),
								priv: Buffer.from(seed).toString('base64url'),
							} as JsonWebKey,
						};
					} else {
						throw new NonRetryableError('Unsupported key size');
					}
				case KeyAlgorithms.Falcon:
					let normalizedFalconKeySize: undefined | 512 | 1024;
					switch (key_size) {
						case 512:
						case 1024:
							normalizedFalconKeySize = key_size;
							break;

						default:
							// Lets try to infer some defaults
							switch (normalizedHashName) {
								case 'SHA-1':
								case 'SHA-224':
								case 'SHA-256':
								case 'SHA-384':
									normalizedFalconKeySize = 512;
									break;
								case 'SHA-512':
									normalizedFalconKeySize = 1024;
									break;
							}
							break;
					}

					if (normalizedFalconKeySize) {
						const { publicKey, secretKey } = (() => {
							switch (normalizedFalconKeySize) {
								case 512:
									return falcon512;
								case 1024:
									return falcon1024;
							}
						})().keygen();

						/**
						 * @link https://datatracker.ietf.org/doc/draft-ietf-cose-falcon/
						 * v4
						 */
						return {
							publicKey: {
								kty: 'AKP',
								alg: `FN-DSA-${normalizedFalconKeySize}`,
								pub: Buffer.from(publicKey).toString('base64url'),
							} as JsonWebKey,
							privateKey: {
								kty: 'AKP',
								alg: `FN-DSA-${normalizedFalconKeySize}`,
								pub: Buffer.from(publicKey).toString('base64url'),
								priv: Buffer.from(secretKey).toString('base64url'),
							} as JsonWebKey,
						};
					} else {
						throw new NonRetryableError('Unsupported key size');
					}

				default:
					throw new NonRetryableError('Unsupported key type');
			}
		}

		// It's technically an anti-pattern to have such a big chunk of logic in a single step, but since this deals with plaintext keys and future keys, we don't want anything to be written to the logs before encryption, so we need to do everything in-memory and in a single step to avoid any accidental leaks.
		const dk_bw_id = await step.do('Generate and save to Bitwarden', DataKeyRotation.bitwardenCallRetry, async () => {
			// Generate the stuff
			const salt = generateSalt();
			const { publicKey, privateKey } = await generateKeys(salt.base64);
			const macInfo = generateMacInfo();

			/**
			 * Connect to root Bitwarden - borrowed from the tenant's session pool when something already has one open on these credentials, opened into it when not. Nothing here closes what it gets back: a pooled session belongs to the tenant and ends itself when its token expires (see `openBitwardenSession` in `~/bitwarden-pool`).
			 */
			const r_accessToken = tenant.jurisdiction === DOJurisdictions['The European Union'] ? this.env.EU_BW_SM_ACCESS_TOKEN : this.env.US_BW_SM_ACCESS_TOKEN;
			const r_bwStub = await openPooledBitwardenSession(this.env, {
				jurisdiction: tenant.jurisdiction,
				t_do_id_hex: tenant.do_id,
				log_t_id_hex: parsedPayload.t_id.hex,
				// Passed through from whoever triggered this rotation - see `workflowParams.u_id`'s doc comment
				u_id: parsedPayload.u_id,
				ak_id: parsedPayload.ak_id,
				endpoints: {
					base: tenant.jurisdiction === DOJurisdictions['The European Union'] ? BitwardenCloudEndpoints.Api.eu : BitwardenCloudEndpoints.Api.us,
					authentication: tenant.jurisdiction === DOJurisdictions['The European Union'] ? BitwardenCloudEndpoints.Identity.eu : BitwardenCloudEndpoints.Identity.us,
				},
				accessToken: r_accessToken,
			});

			if (byo_bw) {
				// Get connection details to customer's Bitwarden
				const [byo_bw_connection] = await r_bwStub.getSecrets([byo_bw]);

				if (byo_bw_connection) {
					// Parse & fix types
					const { value: t_accessToken, note: _note } = byo_bw_connection;
					const note = JSON.parse(_note) as zm.output<typeof TenantByoBwNoteSchema>;

					// Connect to customer's Bitwarden - pooled the same way the root session above is, under the same tenant but its own fingerprint, since the two vaults' sessions are never interchangeable
					const t_bwStub = await openPooledBitwardenSession(this.env, {
						jurisdiction: tenant.jurisdiction,
						t_do_id_hex: tenant.do_id,
						log_t_id_hex: parsedPayload.t_id.hex,
						// Passed through from whoever triggered this rotation - see `workflowParams.u_id`'s doc comment
						u_id: parsedPayload.u_id,
						ak_id: parsedPayload.ak_id,
						endpoints: {
							base: note.endpoints.base,
							authentication: note.endpoints.authentication,
						},
						accessToken: t_accessToken,
					});

					// Save it there
					const secretKey = await t_bwStub.encryptSecret(t_accessToken, [parsedPayload.t_id.base64url, parsedPayload.kr_id.base64url, dk_id.base64url].join('/'));
					const secretValue = await t_bwStub.encryptSecret(t_accessToken, JSON.stringify(privateKey));
					const secretNote = await t_bwStub.encryptSecret(
						t_accessToken,
						JSON.stringify({
							public: publicKey,
							salt: salt.base64url,
							macInfo: macInfo.base64url,
						}),
					);

					const { id } = await t_bwStub.setSecret({
						projectId: note.project,
						key: secretKey,
						value: secretValue,
						note: secretNote,
					});

					const bw_id_hex = id.replaceAll('-', '');
					const bw_id_buffer = Buffer.from(bw_id_hex, 'hex');
					return {
						utf8: id,
						hex: bw_id_hex,
						base64: bw_id_buffer.toString('base64'),
						base64url: bw_id_buffer.toString('base64url'),
					};
				} else {
					// Empty pointer in tenant properties, we should clean it up to avoid confusion in the future
					this.ctx.waitUntil(t_do_stub.updateProperties({ byo_bw: null }));
					throw new NonRetryableError('BYO Bitwarden connection not found');
				}
			} else {
				// We saving here
				const secretKey = await r_bwStub.encryptSecret(r_accessToken, [parsedPayload.t_id.base64url, parsedPayload.kr_id.base64url, dk_id.base64url].join('/'));
				const secretValue = await r_bwStub.encryptSecret(r_accessToken, JSON.stringify(privateKey));
				const secretNote = await r_bwStub.encryptSecret(
					r_accessToken,
					JSON.stringify({
						public: publicKey,
						salt: salt.base64url,
						macInfo: macInfo.base64url,
					}),
				);

				const { id } = await r_bwStub.setSecret({
					projectId: tenant.jurisdiction === DOJurisdictions['The European Union'] ? this.env.EU_BW_SM_PROJECT_ID : this.env.US_BW_SM_PROJECT_ID,
					key: secretKey,
					value: secretValue,
					note: secretNote,
				});

				const bw_id_hex = id.replaceAll('-', '');
				const bw_id_buffer = Buffer.from(bw_id_hex, 'hex');
				return {
					utf8: id,
					hex: bw_id_hex,
					base64: bw_id_buffer.toString('base64'),
					base64url: bw_id_buffer.toString('base64url'),
				};
			}
		});

		await step.do('Save datakey to DB', DataKeyRotation.cfApiCallRetry, () =>
			t_db
				.insert(tenantSchema.datakeys)
				.values({
					dk_id: sql`unhex(${dk_id.hex})`,
					kr_id: sql`unhex(${parsedPayload.kr_id.hex})`,
					bw_id: sql`unhex(${dk_bw_id.hex})`,
				})
				.then(() => {}),
		);

		/**
		 * The one place this event can be logged accurately: whoever triggered this workflow (a dashboard "rotate now" click, a keyring's auto-started first key, or eventually a schedule) only knows the rotation was *requested*, not that it succeeded - a Workflow can retry every step above any number of times before landing here. There's no request in a Workflow, so unlike the dashboard-side logs this one carries no `ip`/`ray_id`/`user_agent`.
		 */
		await step.do('Record audit log', DataKeyRotation.cfApiCallRetry, async () => {
			const now = new Date();

			const log: zm.input<typeof TenantLogQueueMessageSchema> = {
				t_id: parsedPayload.t_id.hex,
				jurisdiction: tenant.jurisdiction,
				id: uuidv7({ msecs: now.getTime() }).replaceAll('-', ''),
				timestamp: now.toISOString(),
				event_type: TenantLogEventType['generated datakey'],
				context: { key: { algorithm: key_type, size: key_size, hash } },
				kr_id: parsedPayload.kr_id.hex,
				dk_id: dk_id.hex,
				// Mirrors `openPooledBitwardenSession`'s own actor selection just above - whoever triggered the rotation, or `system` when nothing did (a schedule/count-based trigger)
				...(parsedPayload.u_id ? { u_id: parsedPayload.u_id } : parsedPayload.ak_id ? { ak_id: parsedPayload.ak_id } : { system: true }),
				status: TenantLogEventStatus.success,
			};
			await TenantLogQueueMessageSchema.parseAsync(log);
			await this.env.LOGS.sendBatch([{ body: log, contentType: 'json' }]);
		});
	}
}
