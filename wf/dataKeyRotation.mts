import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { eq, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { EnvVars } from '../api/src/types.mjs';
import { DBManager, StaticDatabase } from '../shared/db-core/db.mjs';
import { tenants } from '../shared/db-preview/schemas/root';
import { keyrings } from '../shared/db-preview/schemas/tenant';
import { BufferHelpers } from '../shared/helpers/buffers.mjs';
import { CryptoHelpers } from '../shared/helpers/crypto.mjs';
import { Helpers } from '../shared/helpers/index.mjs';
import { KeyAlgorithms } from '../shared/types/crypto/index.mjs';
import { ZodUuidExportInput, type D1Blob } from '../shared/types/d1/index.mjs';

export const workflowParams = z.object({
	t_id: ZodUuidExportInput,
	kr_id: ZodUuidExportInput,
});

export type WorkflowParams = z.infer<typeof workflowParams>;

export class DataKeyRotation extends WorkflowEntrypoint<EnvVars, Params> {
	override async run(event: Readonly<WorkflowEvent<Params>>, step: WorkflowStep) {
		const parsedPayload = await step.do('zod parse payload', () =>
			workflowParams.parseAsync(typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload).catch((err) => {
				throw new NonRetryableError(JSON.stringify(err), 'Bad workflow payload');
			}),
		);

		await step.do('Setup datakey', async () => {
			let t_db: ReturnType<typeof DBManager.getDrizzle> | undefined = undefined;

			if (!Helpers.isLocal(this.env.CF_VERSION_METADATA)) {
				const potentialVipBinding = (await CryptoHelpers.getHash('SHA-256', `t_${(await BufferHelpers.uuidConvert(parsedPayload.t_id)).utf8}${this.env.NODE_ENV !== 'production' && '_p'}`)).toUpperCase();

				if (potentialVipBinding in this.env) {
					t_db = DBManager.getDrizzle(this.env[potentialVipBinding] as D1Database, this.env.NODE_ENV !== 'production');
				}
			}

			if (!t_db) {
				const t_d1_id_utf8 = await step.do(
					'Lookup tenant from root',
					{
						retries: {
							limit: Number.MAX_SAFE_INTEGER,
							/**
							 * CF global rate limit is 1200/5m
							 * @link https://developers.cloudflare.com/fundamentals/api/reference/limits/
							 */
							delay: 5 * 60 * 1000,
							backoff: 'constant',
						},
					},
					() =>
						BufferHelpers.uuidConvert(parsedPayload.t_id).then((t_id) => {
							let r_db: ReturnType<typeof DBManager.getDrizzle>;
							if (Helpers.isLocal(this.env.CF_VERSION_METADATA)) {
								r_db = DBManager.getDrizzle(
									{
										accountId: this.env.CF_ACCOUNT_ID,
										apiToken: this.env.CF_API_TOKEN,
										databaseId: this.env.ENVIRONMENT === 'production' ? StaticDatabase.Root.eaas_root : StaticDatabase.Root.eaas_root_p,
									},
									this.env.NODE_ENV !== 'production',
								);
							} else {
								r_db = DBManager.getDrizzle(this.env.EAAS_ROOT, this.env.NODE_ENV !== 'production');
							}

							return r_db
								.select({
									d1_id: tenants.d1_id,
								})
								.from(tenants)
								.where(eq(tenants.t_id, sql<D1Blob>`unhex(${t_id.hex})`))
								.limit(1)
								.then((rows) =>
									Promise.all(
										rows.map((row) =>
											BufferHelpers.uuidConvert(row.d1_id).then((d1_id) => ({
												...row,
												d1_id,
											})),
										),
									),
								)
								.then(([row]) => {
									if (row) {
										return row.d1_id.utf8;
									} else {
										throw new NonRetryableError('Tenant not found');
									}
								});
						}),
				);

				t_db = DBManager.getDrizzle(
					{
						accountId: this.env.CF_ACCOUNT_ID,
						apiToken: this.env.CF_API_TOKEN,
						databaseId: t_d1_id_utf8,
					},
					this.env.NODE_ENV !== 'production',
				);
			}

			const { key_type, key_size, hash, generation_versions, retreival_versions } = await step.do(
				'Get keyring info',
				{
					retries: {
						limit: Number.MAX_SAFE_INTEGER,
						/**
						 * CF global rate limit is 1200/5m
						 * @link https://developers.cloudflare.com/fundamentals/api/reference/limits/
						 */
						delay: 5 * 60 * 1000,
						backoff: 'constant',
					},
				},
				() =>
					BufferHelpers.uuidConvert(parsedPayload.kr_id).then((kr_id) =>
						t_db
							.select({
								key_type: keyrings.key_type,
								key_size: keyrings.key_size,
								hash: keyrings.hash,
								generation_versions: keyrings.generation_versions,
								retreival_versions: keyrings.retreival_versions,
							})
							.from(keyrings)
							.where(eq(keyrings.kr_id, sql<D1Blob>`unhex(${kr_id.hex})`))
							.limit(1)
							.then(([row]) => {
								if (row) {
									return row;
								} else {
									throw new NonRetryableError('Keyring not found');
								}
							}),
					),
			);

			const salt = await step.do('Generate salt', async () => crypto.getRandomValues(new Uint8Array(createHash(hash).digest().byteLength)));

			const { publicKey, privateKey } = await step.do('Generate key(s)', async () => {
				let normalizedHashName: 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512';
				switch (hash) {
					case 'sha1':
					case 'md5-sha1':
					case 'DSA-SHA1':
					case 'RSA-SHA1':
					case 'ecdsa-with-SHA1':
						normalizedHashName = 'SHA-1';
						break;
					case 'sha256':
					case 'RSA-SHA256':
						normalizedHashName = 'SHA-256';
						break;
					case 'sha384':
					case 'RSA-SHA384':
						normalizedHashName = 'SHA-384';
						break;
					case 'sha512':
					case 'RSA-SHA512':
						normalizedHashName = 'SHA-512';
						break;

					default:
						throw new NonRetryableError('Unsupported hash type');
				}

				switch (key_type) {
					case KeyAlgorithms['RSASSA-PKCS1-v1_5']:
					case KeyAlgorithms['RSA-PSS']:
					case KeyAlgorithms['RSA-OAEP']:
						let normalizedRsaKeySize: undefined | number;
						if (key_size && key_size >= 2048) {
							normalizedRsaKeySize = key_size;
						} else {
							// Lets try to infer some defaults
							switch (normalizedHashName) {
								case 'SHA-256':
								case 'SHA-384':
								case 'SHA-512':
									normalizedRsaKeySize = salt.byteLength * 8 * 8;
									break;
							}
						}

						if (normalizedRsaKeySize) {
							let normalizedUsages: ReadonlyArray<KeyUsage>;
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
									throw new NonRetryableError(err.message, 'Generate key failure');
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
							let normalizedUsages: ReadonlyArray<KeyUsage>;
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
									throw new NonRetryableError(err.message, 'Generate key failure');
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
								throw new NonRetryableError(err.message, 'Generate key failure');
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
							let normalizedUsages: ReadonlyArray<KeyUsage>;
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
									throw new NonRetryableError(err.message, 'Generate key failure');
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
								throw new NonRetryableError(err.message, 'Generate key failure');
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
										return import('@noble/post-quantum/ml-kem').then(({ ml_kem512 }) => ml_kem512);
									case 768:
										return import('@noble/post-quantum/ml-kem').then(({ ml_kem768 }) => ml_kem768);
									case 1024:
										return import('@noble/post-quantum/ml-kem').then(({ ml_kem1024 }) => ml_kem1024);
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
							return (async () => {
								switch (normalizedMldsaKeySize) {
									case 44:
										return import('@noble/post-quantum/ml-dsa').then(({ ml_dsa44 }) => ml_dsa44);
									case 65:
										return import('@noble/post-quantum/ml-dsa').then(({ ml_dsa65 }) => ml_dsa65);
									case 87:
										return import('@noble/post-quantum/ml-dsa').then(({ ml_dsa87 }) => ml_dsa87);
								}
							})().then((ml_dsa) => {
								const { publicKey, secretKey } = ml_dsa.keygen(crypto.getRandomValues(new Uint8Array(256 / 8)));

								return {
									publicKey: {
										kty: 'LWE',
										key_ops: ['sign'],
										alg: `ML-DSA${normalizedMldsaKeySize}`,
										crv: 'CRYSTALS-Dilithium',
										ext: true,
										x: Buffer.from(publicKey).toString('base64url'),
									} as JsonWebKey,
									privateKey: {
										kty: 'LWE',
										key_ops: ['verify'],
										alg: `ML-DSA${normalizedMldsaKeySize}`,
										crv: 'CRYSTALS-Dilithium',
										ext: true,
										x: Buffer.from(publicKey).toString('base64url'),
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
			});
		});
	}
}
