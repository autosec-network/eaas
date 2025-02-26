import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { parseMultipartRequest } from '@mjackson/multipart-parser';
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { endTime, startTime } from 'hono/timing';
import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import isHexadecimal from 'validator/es/lib/isHexadecimal';
import type { ContextVariables, EnvVars } from '~/types.mjs';
import { datakeys, keyrings } from '~shared/db-preview/schemas/tenant';
import { BitwardenHelper } from '~shared/helpers/bitwarden.mjs';
import { BufferHelpers } from '~shared/helpers/buffers.mjs';
import { cipherText0, type SecretNote } from '~shared/types/bw/index.mjs';
import { EncryptionAlgorithms, KeyAlgorithms } from '~shared/types/crypto/index.mjs';
import type { D1Blob } from '~shared/types/d1/index.mjs';

const app = new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>();

app.use('*', async (c, next) => {
	/**
	 * Check if at least one permission has r_encrypt set to true.
	 * We have to check specifics in the route handler to get the keyring name from fields.
	 */
	if (Object.values(c.var.permissions).some(({ r_encrypt }) => r_encrypt)) {
		await next();
	} else {
		console.log("Token doesn't have permissions");
		return c.json({ success: false, errors: [{ message: 'Access Denied: You do not have permission to perform this action', extensions: { code: 403 } }] }, 403);
	}
});

const exampleInput = 'Hello world';
const exampleOutput: Parameters<typeof cipherText0>[1] = {
	// @ts-expect-error all that's actually used
	dk_id: {
		hex: '00000000000000000000000000000000',
		base64: Buffer.from('00000000000000000000000000000000', 'hex').toString('base64'),
		base64url: Buffer.from('00000000000000000000000000000000', 'hex').toString('base64url'),
	},
	algorithm: EncryptionAlgorithms['AES-GCM'],
	bitStrength: '256',
	preamble: new Uint8Array(96 / 8),
	cipherBuffer: new Uint8Array(Math.floor(Math.random() * 100)),
	signature: new Uint8Array(512 / 8),
};

const embededInputBase = z.object({
	keyringName: z.string().trim().min(1).toLowerCase().describe('Specifies the name of the key ring to use, case insensitive'),
	algorithm: z.nativeEnum(EncryptionAlgorithms).describe('Specifies the encryption algorithm to use').openapi({ example: EncryptionAlgorithms['AES-GCM'] }),
	bitStrength: z.enum(['128', '192', '256']).describe('Specifies the bit strength of the encryption algorithm').openapi({ example: '256' }),
	outputFormat: z.enum(['base64', 'base64url', 'hex']).describe('Specifies the output encoding').openapi({ example: 'base64' }),
});

const embededInput = z.discriminatedUnion('inputFormat', [
	embededInputBase.extend({
		input: z
			.string()
			.trim()
			.describe('Specifies the utf8 encoded input data')
			.openapi({ example: Buffer.from(exampleInput, 'utf8').toString('utf8') }),
		inputFormat: z.literal('utf8').describe('Specifies the input encoding'),
		reference: z.string().trim().optional().describe('An optional string that will be present in the reference field on the corresponding item in the response, to assist in understanding which result corresponds to a particular input'),
	}),
	embededInputBase.extend({
		input: z
			.string()
			.trim()
			.refine((value) => isHexadecimal(value))
			.describe('Specifies the hex encoded input data')
			.openapi({ example: Buffer.from(exampleInput, 'utf8').toString('hex') }),
		inputFormat: z.literal('hex').describe('Specifies the input encoding'),
		reference: z.string().trim().optional().describe('An optional string that will be present in the reference field on the corresponding item in the response, to assist in understanding which result corresponds to a particular input'),
	}),
	embededInputBase.extend({
		input: z.union([
			z
				.string()
				.trim()
				.base64()
				.describe('Specifies the base64 encoded input data')
				.openapi({ example: Buffer.from(exampleInput, 'utf8').toString('base64') }),
			z
				.string()
				.trim()
				.base64url()
				.describe('Specifies the base64url encoded input data')
				.openapi({ example: Buffer.from(exampleInput, 'utf8').toString('base64url') }),
		]),
		inputFormat: z.literal('base64').describe('Specifies the input encoding'),
		reference: z.string().trim().optional().describe('An optional string that will be present in the reference field on the corresponding item in the response, to assist in understanding which result corresponds to a particular input'),
	}),
]);

const embededOutputBase = z.object({
	reference: z.string().trim().optional().describe('The value of the `reference` field from the corresponding item in the request'),
});
const embededOutput = z.union([
	embededOutputBase.extend({
		value: z
			.string()
			.trim()
			.base64()
			.describe('The encrypted text to store, base64 encoded.')
			.openapi({ example: cipherText0('base64', exampleOutput) }),
	}),
	embededOutputBase.extend({
		value: z
			.string()
			.trim()
			.base64url()
			.describe('The encrypted text to store, base64url encoded.')
			.openapi({ example: cipherText0('base64url', exampleOutput) }),
	}),
	embededOutputBase.extend({
		value: z
			.string()
			.trim()
			.refine((value) => isHexadecimal(value))
			.describe('The encrypted text to store, hex encoded.')
			.openapi({ example: cipherText0('hex', exampleOutput) }),
	}),
]);

export const embededRoute = createRoute({
	method: 'post',
	path: '/',
	description: 'This endpoint returns the cryptographic hash of given data using the specified algorithm',
	request: {
		body: {
			content: {
				'application/json': {
					schema: z
						.union([
							z.object({
								batch_input: z.array(embededInput).nonempty(),
							}),
							embededInput,
						])
						.openapi('EncryptEmbedInput'),
				},
			},
		},
	},
	responses: {
		200: {
			content: {
				'application/json': {
					schema: z
						.object({
							success: z.boolean(),
							result: z.union([z.array(embededOutput), embededOutput]),
						})
						.openapi('EncryptEmbedOutput'),
				},
			},
			description: 'Returns the cryptographic hash',
		},
	},
});

async function generateKey({ key_type, key_size, hash, privateKey, publicKey, salt, macInfo, algorithm, algorithmSize }: { key_type: KeyAlgorithms; key_size?: number; hash: typeof keyrings.$inferSelect.hash; privateKey: JsonWebKey; publicKey?: JsonWebKey; salt: ArrayBufferLike; macInfo: ArrayBufferLike; algorithm: EncryptionAlgorithms; algorithmSize: z.infer<typeof embededInputBase>['bitStrength'] }): Promise<{ key: CryptoKey; mac: CryptoKey }> {
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
			throw new Error('Unsupported hash type');
	}

	let keyMaterial: CryptoKey;

	/**
	 * If key has native derive key, we'll use it.
	 * Otherwise we'll merge the raw keys (private + public?) and derive key using hkdf
	 */
	switch (key_type) {
		case KeyAlgorithms['RSASSA-PKCS1-v1_5']:
		case KeyAlgorithms['RSA-PSS']:
		case KeyAlgorithms['RSA-OAEP']:
			let rsaNormalizedUsages: ReadonlyArray<KeyUsage>;
			switch (key_type) {
				case KeyAlgorithms['RSASSA-PKCS1-v1_5']:
				case KeyAlgorithms['RSA-PSS']:
					rsaNormalizedUsages = ['sign'];
					break;
				case KeyAlgorithms['RSA-OAEP']:
					rsaNormalizedUsages = ['encrypt'];
			}

			// Guaranteed private key import
			const rsaImportPromises = [
				crypto.subtle.importKey(
					'jwk',
					privateKey,
					{
						name: Object.entries(KeyAlgorithms).find((algo) => algo[1] === key_type)![0],
						hash: normalizedHashName,
					} satisfies RsaHashedImportParams,
					true,
					rsaNormalizedUsages,
				),
			];

			// Optional public key import
			if (publicKey)
				rsaImportPromises.push(
					crypto.subtle.importKey(
						'jwk',
						publicKey,
						{
							name: Object.entries(KeyAlgorithms).find((algo) => algo[1] === key_type)![0],
							hash: normalizedHashName,
						} satisfies RsaHashedImportParams,
						true,
						rsaNormalizedUsages,
					),
				);

			// Merge keys
			const rsaRawKeys = (await Promise.all(rsaImportPromises).then((importedKeys) => Promise.all(importedKeys.map((importedKey) => crypto.subtle.exportKey('raw', importedKey))))).map((rawKey) => new Uint8Array(rawKey));

			const rsaCombinedRawKeys = new Uint8Array(rsaRawKeys.reduce((sum, buf) => sum + buf.byteLength, 0));
			// Insert each one into combined
			rsaRawKeys.forEach((rawKey, index) => {
				rsaCombinedRawKeys.set(rawKey, index === 0 ? 0 : rsaRawKeys[index - 1]!.byteLength);
			});

			keyMaterial = await crypto.subtle.importKey('raw', rsaCombinedRawKeys, { name: 'HKDF' }, false, ['deriveKey']);
			break;
		case KeyAlgorithms.ECDSA:
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
						default:
							throw new Error('Unsupported curve');
					}
					break;
			}

			// Guaranteed private key import
			const ecdsaImportPromises = [
				crypto.subtle.importKey(
					'jwk',
					privateKey,
					{
						name: Object.entries(KeyAlgorithms).find((algo) => algo[1] === key_type)![0],
						namedCurve: normalizedEccCurve,
					} satisfies EcKeyImportParams,
					false,
					['sign'],
				),
			];

			// Optional public key import
			if (publicKey)
				ecdsaImportPromises.push(
					crypto.subtle.importKey(
						'jwk',
						publicKey,
						{
							name: Object.entries(KeyAlgorithms).find((algo) => algo[1] === key_type)![0],
							namedCurve: normalizedEccCurve,
						} satisfies EcKeyImportParams,
						false,
						['sign'],
					),
				);

			// Merge keys
			const ecdsaRawKeys = (await Promise.all(ecdsaImportPromises).then((importedKeys) => Promise.all(importedKeys.map((importedKey) => crypto.subtle.exportKey('raw', importedKey))))).map((rawKey) => new Uint8Array(rawKey));

			const ecdsaCombinedRawKeys = new Uint8Array(ecdsaRawKeys.reduce((sum, buf) => sum + buf.byteLength, 0));
			// Insert each one into combined
			ecdsaRawKeys.forEach((rawKey, index) => {
				ecdsaCombinedRawKeys.set(rawKey, index === 0 ? 0 : ecdsaRawKeys[index - 1]!.byteLength);
			});

			keyMaterial = await crypto.subtle.importKey('raw', ecdsaCombinedRawKeys, { name: 'HKDF' }, false, ['deriveKey']);
			break;
		/**
		 * @todo
		 */
		case KeyAlgorithms['ML-KEM']:
		case KeyAlgorithms['ML-DSA']:
		case KeyAlgorithms['SLH-DSA-SHA2-S']:
		case KeyAlgorithms['SLH-DSA-SHA2-F']:
		case KeyAlgorithms['SLH-DSA-SHAKE-S']:
		case KeyAlgorithms['SLH-DSA-SHAKE-F']:
			// Guaranteed private key import
			const pqcRawKeys = [new Uint8Array(Buffer.from(privateKey.d!, 'base64url'))];

			// Optional public key import
			if (publicKey) pqcRawKeys.push(new Uint8Array(Buffer.from(publicKey.x!, 'base64url')));

			// Merge keys
			const pqcCombinedRawKeys = new Uint8Array(pqcRawKeys.reduce((sum, buf) => sum + buf.byteLength, 0));
			// Insert each one into combined
			pqcRawKeys.forEach((rawKey, index) => {
				pqcCombinedRawKeys.set(rawKey, index === 0 ? 0 : pqcRawKeys[index - 1]!.byteLength);
			});

			keyMaterial = await crypto.subtle.importKey('raw', pqcCombinedRawKeys, { name: 'HKDF' }, false, ['deriveKey']);
			break;
		default:
			throw new Error('Unsupported key type');
	}

	return Promise.all([
		crypto.subtle.deriveKey(
			{
				name: 'HKDF',
				salt: new Uint8Array(salt),
				hash: normalizedHashName,
				info: new Uint8Array(),
			} satisfies HkdfParams,
			keyMaterial,
			{
				name: Object.entries(EncryptionAlgorithms).find((algo) => algo[1] === algorithm)![0],
				length: parseInt(algorithmSize),
			} satisfies AesDerivedKeyParams,
			false,
			['encrypt'],
		),
		crypto.subtle.deriveKey(
			{
				name: 'HKDF',
				salt: new Uint8Array(salt),
				hash: normalizedHashName,
				info: new Uint8Array(macInfo),
			} satisfies HkdfParams,
			keyMaterial,
			{
				name: 'HMAC',
				hash: normalizedHashName,
			} satisfies HmacKeyGenParams,
			false,
			['sign'],
		),
	]).then(([key, mac]) => ({ key, mac }));
}

async function encryptContent({ algorithm, key, inputFormat, input }: { algorithm: EncryptionAlgorithms; key: CryptoKey; inputFormat: z.infer<typeof embededInput>['inputFormat'] | 'buffer'; input: z.infer<typeof embededInput>['input'] | ArrayBufferLike }) {
	switch (algorithm) {
		case EncryptionAlgorithms['AES-GCM']:
			// AES-GCM uses a 96-bit iv
			const gcmIv = crypto.getRandomValues(new Uint8Array(96 / 8));

			return crypto.subtle
				.encrypt(
					{
						name: Object.entries(EncryptionAlgorithms).find((algo) => algo[1] === algorithm)![0],
						iv: gcmIv,
					} satisfies AesGcmParams,
					key,
					inputFormat === 'buffer' ? new Uint8Array(input as ArrayBufferLike) : inputFormat === 'base64' ? new Uint8Array(await BufferHelpers.base64ToBuffer(input as string)) : Buffer.from(input as string, inputFormat),
				)
				.then((cipherBuffer) => ({
					cipherBuffer: new Uint8Array(cipherBuffer),
					preamble: gcmIv,
				}));
		case EncryptionAlgorithms['AES-CBC']:
			// AES-CBC uses a 128-bit iv
			const cbcIv = crypto.getRandomValues(new Uint8Array(128 / 8));

			return crypto.subtle
				.encrypt(
					{
						name: Object.entries(EncryptionAlgorithms).find((algo) => algo[1] === algorithm)![0],
						iv: cbcIv,
					} satisfies AesCbcParams,
					key,
					inputFormat === 'buffer' ? new Uint8Array(input as ArrayBufferLike) : inputFormat === 'base64' ? new Uint8Array(await BufferHelpers.base64ToBuffer(input as string)) : Buffer.from(input as string, inputFormat),
				)
				.then((cipherBuffer) => ({
					cipherBuffer: new Uint8Array(cipherBuffer),
					preamble: cbcIv,
				}));
		case EncryptionAlgorithms['AES-CTR']:
			// AES-CTR uses a 128-bit counter
			const ctrCounter = crypto.getRandomValues(new Uint8Array(128 / 8));

			return crypto.subtle
				.encrypt(
					{
						name: Object.entries(EncryptionAlgorithms).find((algo) => algo[1] === algorithm)![0],
						counter: ctrCounter,
						/**
						 * The NIST SP800-38A standard, which defines CTR, suggests that the counter should occupy half of the counter block
						 * @link https://csrc.nist.gov/pubs/sp/800/38/a/final
						 */
						length: (ctrCounter.byteLength * 8) / 2,
					} satisfies AesCtrParams,
					key,
					inputFormat === 'buffer' ? new Uint8Array(input as ArrayBufferLike) : inputFormat === 'base64' ? new Uint8Array(await BufferHelpers.base64ToBuffer(input as string)) : Buffer.from(input as string, inputFormat),
				)
				.then((cipherBuffer) => ({
					cipherBuffer: new Uint8Array(cipherBuffer),
					preamble: ctrCounter,
				}));
	}
}

app.openapi(embededRoute, async (c) => {
	// Needs to be set to a variable or else type isn't inferred
	const json = c.req.valid('json');

	if ('batch_input' in json) {
		// Filter out inputs that don't use keyrings we're allowed to access
		const allowedInputs = json.batch_input.filter(
			({ keyringName }) =>
				Object.values(c.var.permissions).find((keyring_permission) => {
					const name1 = Buffer.from(keyring_permission.kr_name.toLowerCase());
					const name2 = Buffer.from(keyringName.toLowerCase());
					return name1.byteLength === name2.byteLength && timingSafeEqual(name1, name2);
				})?.r_encrypt,
		);

		if (allowedInputs.length > 0) {
			// Get every unique keyring name from the allowed inputs
			const keyringPermissions = await Promise.all(
				Array.from(new Set(allowedInputs.map(({ keyringName }) => keyringName))).map(async (name) => {
					const [kr_id_base64url] = Object.entries(c.var.permissions).find(([, keyring_permission]) => {
						const name1 = Buffer.from(keyring_permission.kr_name.toLowerCase());
						const name2 = Buffer.from(name.toLowerCase());
						return name1.byteLength === name2.byteLength && timingSafeEqual(name1, name2);
					})!;

					return {
						// Get the base64url encoded keyring id (the key of the permission object)
						kr_id: await BufferHelpers.uuidConvert(kr_id_base64url),
						// Carry over the name for lookup
						name,
					};
				}),
			);

			// Efficient batch retreive datakeys
			startTime(c, 'db-fetch-datakeys');
			const receivedDatakeys = await c.var.t_db
				.select({
					dk_id: datakeys.dk_id,
					kr_id: datakeys.kr_id,
					bw_id: datakeys.bw_id,
					generation_count: datakeys.generation_count,
					key_type: keyrings.key_type,
					key_size: keyrings.key_size,
					hash: keyrings.hash,
				})
				.from(datakeys)
				.innerJoin(keyrings, eq(keyrings.kr_id, datakeys.kr_id))
				.where(
					// @ts-expect-error drizzle expects guarantee of atleast one element
					inArray(
						keyrings.kr_id,
						keyringPermissions.map(({ kr_id }) => sql<D1Blob>`unhex(${kr_id.hex})`),
					),
				)
				.orderBy(desc(datakeys.b_time))
				.groupBy(datakeys.kr_id)
				.then((rows) =>
					Promise.all(
						rows.map(({ key_type, key_size, hash, ...row }) =>
							Promise.all([BufferHelpers.uuidConvert(row.dk_id), BufferHelpers.uuidConvert(row.kr_id), BufferHelpers.bufferToBigint(row.generation_count)]).then(async ([dk_id, kr_id, generation_count]) => ({
								dk_id,
								kr_id,
								generation_count,
								key_type,
								key_size,
								hash,
								...(row.bw_id && { bw_id: await BufferHelpers.uuidConvert(row.bw_id) }),
								// Merge back name for lookup
								name: keyringPermissions.find((keyrings) => timingSafeEqual(new Uint8Array(keyrings.kr_id.blob), new Uint8Array(kr_id.blob)))!.name,
							})),
						),
					),
				);
			endTime(c, 'db-fetch-datakeys');

			const returningCiphertexts: z.infer<typeof embededOutput>[] = [];

			// Get all the datakeys backed by bitwarden
			const bwDatakeys = receivedDatakeys.filter(({ bw_id }) => bw_id !== undefined).map((datakey) => ({ ...datakey, bw_id: datakey.bw_id! }));

			if (bwDatakeys.length > 0) {
				startTime(c, 'bitwarden-auth');
				const jwt = await BitwardenHelper.identity(c.env.US_BW_SM_ACCESS_TOKEN);
				endTime(c, 'bitwarden-auth');

				const bws = new BitwardenHelper(jwt);

				// Get all the unique keys from bitwarden and parse them into formats needeed + carry over db metadata (for filtering purposes)
				startTime(c, 'bitwarden-fetch-datakeys');
				const bwKeys = await bws.getSecrets(bwDatakeys.map(({ bw_id }) => bw_id.utf8)).then((retreivedKeys) =>
					Promise.all(
						retreivedKeys.map((retreivedKey) =>
							Promise.all([bws.decryptSecret(retreivedKey.key), bws.decryptSecret(retreivedKey.value), bws.decryptSecret(retreivedKey.note)]).then(async ([key, value, note]) => {
								const [, kr_id_utf8] = key.split('/');
								const { dk_id, name, key_type, key_size, hash } = bwDatakeys.find((datakeys) => datakeys.kr_id.utf8 === kr_id_utf8)!;
								const jsonNote = JSON.parse(note) as SecretNote;

								return {
									name,
									key_type,
									key_size,
									hash,
									dk_id,
									private: JSON.parse(value) as JsonWebKey,
									// Must use spread because `public` is a reserved name
									...jsonNote,
									salt: await BufferHelpers.base64ToBuffer(jsonNote.salt),
									macInfo: await BufferHelpers.base64ToBuffer(jsonNote.macInfo),
								};
							}),
						),
					),
				);
				endTime(c, 'bitwarden-fetch-datakeys');

				await Promise.all(
					allowedInputs.map(async (allowedInput) => {
						// Get correlating key from bitwarden keys
						const bwKey = bwKeys.find((bwKey) => bwKey.name.toLowerCase() === allowedInput.keyringName.toLowerCase());

						if (bwKey) {
							startTime(c, `${allowedInput.reference && `${allowedInput.reference}|`}encrypt-compute-keys`);
							// Comute actual encryption key from data key(s)
							return generateKey({
								algorithm: allowedInput.algorithm,
								algorithmSize: allowedInput.bitStrength,
								hash: bwKey.hash,
								key_type: bwKey.key_type,
								key_size: bwKey.key_size ?? undefined,
								salt: bwKey.salt,
								macInfo: bwKey.macInfo,
								privateKey: bwKey.private,
								publicKey: bwKey.public,
							}).then(({ key, mac }) => {
								endTime(c, `${allowedInput.reference && `${allowedInput.reference}|`}encrypt-compute-keys`);

								startTime(c, `${allowedInput.reference && `${allowedInput.reference}|`}encrypt-cipher`);
								// Actually encrypt
								return encryptContent({
									algorithm: allowedInput.algorithm,
									key,
									input: allowedInput.input,
									inputFormat: allowedInput.inputFormat,
								}).then(({ preamble, cipherBuffer }) => {
									endTime(c, `${allowedInput.reference && `${allowedInput.reference}|`}encrypt-cipher`);

									startTime(c, `${allowedInput.reference && `${allowedInput.reference}|`}encrypt-sign`);
									// Sign over IV || data (to account for algorithms that don't have proper validation)
									const mergedBuffer = new Uint8Array(preamble.length + cipherBuffer.length);
									mergedBuffer.set(preamble, 0);
									mergedBuffer.set(cipherBuffer, preamble.length);

									return crypto.subtle.sign({ name: 'HMAC' }, mac, mergedBuffer).then((signature) => {
										endTime(c, `${allowedInput.reference && `${allowedInput.reference}|`}encrypt-sign`);

										/**
										 * Update encryption counter
										 *
										 * Potential inconsistency, but can't be resolved until D1 supports transactions
										 * @link https://github.com/cloudflare/workers-sdk/issues/2733
										 */
										c.executionCtx.waitUntil(
											c.var.t_db
												.select({ generation_count: datakeys.generation_count })
												.from(datakeys)
												.where(eq(datakeys.dk_id, sql<D1Blob>`unhex(${bwKey.dk_id.hex})`))
												.limit(1)
												.then((rows) =>
													Promise.all(
														rows.map(async (row) => ({
															...row,
															generation_count: await BufferHelpers.bufferToBigint(row.generation_count),
														})),
													),
												)
												.then(([row]) => {
													if (row) {
														return c.var.t_db
															.update(datakeys)
															.set({
																generation_count: sql<D1Blob>`unhex(${BufferHelpers.bigintToHex(++row.generation_count)})`,
															})
															.where(eq(datakeys.dk_id, sql<D1Blob>`unhex(${bwKey.dk_id.hex})`))
															.limit(1);
													} else {
														throw new Error('Datakey not found');
													}
												}),
										);

										// Append back
										returningCiphertexts.push({
											value: cipherText0(allowedInput.outputFormat, {
												dk_id: bwKey.dk_id,
												algorithm: allowedInput.algorithm,
												bitStrength: allowedInput.bitStrength,
												preamble,
												cipherBuffer,
												signature: new Uint8Array(signature),
											}),
											reference: allowedInput.reference,
										});
									});
								});
							});
						} else {
							return undefined;
						}
					}),
				);
			}

			return c.json(
				{
					success: returningCiphertexts.length > 0,
					result: returningCiphertexts,
				},
				returningCiphertexts.length > 0 ? 200 : 422,
			);
		} else {
			return c.json({ success: false, errors: [{ message: 'Access Denied: You do not have permission to perform this action', extensions: { code: 403 } }] }, 403);
		}
	} else {
		const keyring_permissions = Object.entries(c.var.permissions).find(([, keyring_permission]) => keyring_permission.kr_name.toLowerCase() === json.keyringName.toLowerCase());

		if (keyring_permissions) {
			const [kr_id_base64url, keyring_permission] = keyring_permissions;
			const kr_id = await BufferHelpers.uuidConvert(kr_id_base64url);

			startTime(c, 'db-fetch-datakeys');
			const receivedDatakeys = await c.var.t_db
				.select({
					dk_id: datakeys.dk_id,
					kr_id: datakeys.kr_id,
					bw_id: datakeys.bw_id,
					generation_count: datakeys.generation_count,
					key_type: keyrings.key_type,
					key_size: keyrings.key_size,
					hash: keyrings.hash,
				})
				.from(datakeys)
				.innerJoin(keyrings, eq(keyrings.kr_id, datakeys.kr_id))
				.where(eq(keyrings.kr_id, sql<D1Blob>`unhex(${kr_id.hex})`))
				.orderBy(desc(datakeys.b_time))
				// versions is 0 based
				.limit(keyring_permission.generation_versions + 1)
				.then((rows) =>
					Promise.all(
						rows.map(({ key_type, key_size, hash, ...row }) =>
							Promise.all([BufferHelpers.uuidConvert(row.dk_id), BufferHelpers.uuidConvert(row.kr_id), BufferHelpers.bufferToBigint(row.generation_count)]).then(async ([dk_id, kr_id, generation_count]) => ({
								dk_id,
								kr_id,
								generation_count,
								key_type,
								key_size,
								hash,
								...(row.bw_id && { bw_id: await BufferHelpers.uuidConvert(row.bw_id) }),
							})),
						),
					),
				);
			endTime(c, 'db-fetch-datakeys');

			// Get all the datakeys backed by bitwarden
			const bwDatakeys = receivedDatakeys.filter(({ bw_id }) => bw_id !== undefined).map((datakey) => ({ ...datakey, bw_id: datakey.bw_id! }));

			if (bwDatakeys.length > 0) {
				startTime(c, 'bitwarden-auth');
				const jwt = await BitwardenHelper.identity(c.env.US_BW_SM_ACCESS_TOKEN);
				endTime(c, 'bitwarden-auth');

				const bws = new BitwardenHelper(jwt);

				// Get all the unique keys from bitwarden and parse them into formats needeed + carry over db metadata (for filtering purposes)
				startTime(c, 'bitwarden-fetch-datakeys');
				const bwKeys = await bws.getSecrets(bwDatakeys.map(({ bw_id }) => bw_id.utf8)).then((retreivedKeys) =>
					Promise.all(
						retreivedKeys.map((retreivedKey) =>
							Promise.all([bws.decryptSecret(retreivedKey.key), bws.decryptSecret(retreivedKey.value), bws.decryptSecret(retreivedKey.note)]).then(async ([key, value, note]) => {
								const [, kr_id_utf8] = key.split('/');
								const { dk_id, key_type, key_size, hash } = bwDatakeys.find((datakeys) => datakeys.kr_id.utf8 === kr_id_utf8)!;
								const jsonNote = JSON.parse(note) as SecretNote;

								return {
									key_type,
									key_size,
									hash,
									dk_id,
									private: JSON.parse(value) as JsonWebKey,
									// Must use spread because `public` is a reserved name
									...jsonNote,
									salt: await BufferHelpers.base64ToBuffer(jsonNote.salt),
									macInfo: await BufferHelpers.base64ToBuffer(jsonNote.macInfo),
								};
							}),
						),
					),
				);
				endTime(c, 'bitwarden-fetch-datakeys');

				// Get correlating key from bitwarden keys
				const bwKey = bwKeys[0];

				if (bwKey) {
					startTime(c, 'encrypt-compute-keys');
					// Comute actual encryption key from data key(s)
					return generateKey({
						algorithm: json.algorithm,
						algorithmSize: json.bitStrength,
						hash: bwKey.hash,
						key_type: bwKey.key_type,
						key_size: bwKey.key_size ?? undefined,
						salt: bwKey.salt,
						macInfo: bwKey.macInfo,
						privateKey: bwKey.private,
						publicKey: bwKey.public,
					}).then(({ key, mac }) => {
						endTime(c, 'encrypt-compute-keys');

						startTime(c, 'encrypt-cipher');
						// Actually encrypt
						return encryptContent({
							algorithm: json.algorithm,
							key,
							input: json.input,
							inputFormat: json.inputFormat,
						}).then(({ preamble, cipherBuffer }) => {
							endTime(c, 'encrypt-cipher');

							startTime(c, 'encrypt-sign');
							// Sign over IV || data (to account for algorithms that don't have proper validation)
							const mergedBuffer = new Uint8Array(preamble.length + cipherBuffer.length);
							mergedBuffer.set(preamble, 0);
							mergedBuffer.set(cipherBuffer, preamble.length);

							return crypto.subtle.sign({ name: 'HMAC' }, mac, mergedBuffer).then((signature) => {
								endTime(c, 'encrypt-sign');

								/**
								 * Update encryption counter
								 *
								 * Potential inconsistency, but can't be resolved until D1 supports transactions
								 * @link https://github.com/cloudflare/workers-sdk/issues/2733
								 */
								c.executionCtx.waitUntil(
									c.var.t_db
										.select({ generation_count: datakeys.generation_count })
										.from(datakeys)
										.where(eq(datakeys.dk_id, sql<D1Blob>`unhex(${bwKey.dk_id.hex})`))
										.limit(1)
										.then((rows) =>
											Promise.all(
												rows.map(async (row) => ({
													...row,
													generation_count: await BufferHelpers.bufferToBigint(row.generation_count),
												})),
											),
										)
										.then(([row]) => {
											if (row) {
												return c.var.t_db
													.update(datakeys)
													.set({
														generation_count: sql<D1Blob>`unhex(${BufferHelpers.bigintToHex(++row.generation_count)})`,
													})
													.where(eq(datakeys.dk_id, sql<D1Blob>`unhex(${bwKey.dk_id.hex})`))
													.limit(1);
											} else {
												throw new Error('Datakey not found');
											}
										}),
								);

								return c.json(
									{
										success: true,
										result: {
											value: cipherText0(json.outputFormat, {
												dk_id: bwKey.dk_id,
												algorithm: json.algorithm,
												bitStrength: json.bitStrength,
												preamble,
												cipherBuffer,
												signature: new Uint8Array(signature),
											}),
											reference: json.reference,
										},
									},
									200,
								);
							});
						});
					});
				} else {
					return c.json({ success: false, errors: [{ message: 'Matching key not found in datastore', extensions: { code: 500 } }] }, 500);
				}
			} else {
				return c.json({ success: false, errors: [{ message: 'Unsupported data store', extensions: { code: 500 } }] }, 500);
			}
		} else {
			return c.json({ success: false, errors: [{ message: 'Access Denied: You do not have permission to perform this action', extensions: { code: 403 } }] }, 403);
		}
	}
});

const zodFileObject = z
	.object({
		name: z
			.string()
			.trim()
			.regex(new RegExp(/.+\.\w+/i)),
		lastModified: z.number().int().positive().finite().safe(),
		size: z.number().int().positive().finite().safe(),
		type: z
			.string()
			.trim()
			.regex(new RegExp(/\w+\/\w+/i)),
	})
	.openapi({ type: 'string', format: 'binary' });
const uploadedInput = z.object({
	files: z.union([z.array(zodFileObject).nonempty(), zodFileObject]),
});

const uploadedOutput = z.object({
	value: z
		.string()
		.trim()
		.base64()
		.describe('The hash of the input data, base64 encoded.')
		.openapi({ example: cipherText0('base64', exampleOutput) }),
	filename: z.string().trim(),
});

export const uploadedRoute = createRoute({
	method: 'post',
	path: '/{keyringName}/{algorithm}/{bitStrength}',
	description: 'This endpoint returns the cryptographic hash of uploaded file(s) using the specified algorithm',
	request: {
		params: z.object({
			keyringName: z.string().trim().min(1).toLowerCase().describe('Specifies the name of the key ring to use, case insensitive'),
			algorithm: z.nativeEnum(EncryptionAlgorithms).describe('Specifies the encryption algorithm to use').openapi({ example: EncryptionAlgorithms['AES-GCM'] }),
			bitStrength: z.enum(['128', '192', '256']).describe('Specifies the bit strength of the encryption algorithm').openapi({ example: '256' }),
		}),
		body: {
			content: {
				'multipart/form-data': {
					schema: uploadedInput.openapi('EncryptUploadInput'),
				},
			},
		},
	},
	responses: {
		200: {
			content: {
				'application/json': {
					schema: z
						.object({
							success: z.boolean(),
							result: z.union([z.array(uploadedOutput), uploadedOutput]),
						})
						.openapi('EncryptUploadOutput'),
				},
			},
			description: 'Returns the cryptographic hash',
		},
	},
});

app.openapi(uploadedRoute, async (c) => {
	// Needs to be set to a variable or else type isn't inferred
	const param = c.req.valid('param');

	const keyring_permissions = Object.entries(c.var.permissions).find(([, keyring_permission]) => keyring_permission.kr_name.toLowerCase() === param.keyringName.toLowerCase());

	if (keyring_permissions) {
		const returningCiphertexts: z.infer<typeof uploadedOutput>[] = [];

		const [kr_id_base64url, keyring_permission] = keyring_permissions;
		const kr_id = await BufferHelpers.uuidConvert(kr_id_base64url);

		startTime(c, 'db-fetch-datakeys');
		const receivedDatakeys = await c.var.t_db
			.select({
				dk_id: datakeys.dk_id,
				kr_id: datakeys.kr_id,
				bw_id: datakeys.bw_id,
				generation_count: datakeys.generation_count,
				key_type: keyrings.key_type,
				key_size: keyrings.key_size,
				hash: keyrings.hash,
			})
			.from(datakeys)
			.innerJoin(keyrings, eq(keyrings.kr_id, datakeys.kr_id))
			.where(eq(keyrings.kr_id, sql<D1Blob>`unhex(${kr_id.hex})`))
			.orderBy(desc(datakeys.b_time))
			// versions is 0 based
			.limit(keyring_permission.generation_versions + 1)
			.then((rows) =>
				Promise.all(
					rows.map(({ key_type, key_size, hash, ...row }) =>
						Promise.all([BufferHelpers.uuidConvert(row.dk_id), BufferHelpers.uuidConvert(row.kr_id), BufferHelpers.bufferToBigint(row.generation_count)]).then(async ([dk_id, kr_id, generation_count]) => ({
							dk_id,
							kr_id,
							generation_count,
							key_type,
							key_size,
							hash,
							...(row.bw_id && { bw_id: await BufferHelpers.uuidConvert(row.bw_id) }),
						})),
					),
				),
			);
		endTime(c, 'db-fetch-datakeys');

		// Get all the datakeys backed by bitwarden
		const bwDatakeys = receivedDatakeys.filter(({ bw_id }) => bw_id !== undefined).map((datakey) => ({ ...datakey, bw_id: datakey.bw_id! }));

		if (bwDatakeys.length > 0) {
			startTime(c, 'bitwarden-auth');
			const jwt = await BitwardenHelper.identity(c.env.US_BW_SM_ACCESS_TOKEN);
			endTime(c, 'bitwarden-auth');

			const bws = new BitwardenHelper(jwt);

			// Get all the unique keys from bitwarden and parse them into formats needeed + carry over db metadata (for filtering purposes)
			startTime(c, 'bitwarden-fetch-datakeys');
			const bwKeys = await bws.getSecrets(bwDatakeys.map(({ bw_id }) => bw_id.utf8)).then((retreivedKeys) =>
				Promise.all(
					retreivedKeys.map((retreivedKey) =>
						Promise.all([bws.decryptSecret(retreivedKey.key), bws.decryptSecret(retreivedKey.value), bws.decryptSecret(retreivedKey.note)]).then(async ([key, value, note]) => {
							const [, kr_id_utf8] = key.split('/');
							const { dk_id, key_type, key_size, hash } = bwDatakeys.find((datakeys) => datakeys.kr_id.utf8 === kr_id_utf8)!;
							const jsonNote = JSON.parse(note) as SecretNote;

							return {
								key_type,
								key_size,
								hash,
								dk_id,
								private: JSON.parse(value) as JsonWebKey,
								// Must use spread because `public` is a reserved name
								...jsonNote,
								salt: await BufferHelpers.base64ToBuffer(jsonNote.salt),
								macInfo: await BufferHelpers.base64ToBuffer(jsonNote.macInfo),
							};
						}),
					),
				),
			);
			endTime(c, 'bitwarden-fetch-datakeys');

			// Get correlating key from bitwarden keys
			const bwKey = bwKeys[0];

			if (bwKey) {
				startTime(c, 'encrypt-compute-keys');
				// Comute actual encryption key from data key(s)
				await generateKey({
					algorithm: param.algorithm,
					algorithmSize: param.bitStrength,
					hash: bwKey.hash,
					key_type: bwKey.key_type,
					key_size: bwKey.key_size ?? undefined,
					salt: bwKey.salt,
					macInfo: bwKey.macInfo,
					privateKey: bwKey.private,
					publicKey: bwKey.public,
				}).then(async ({ key, mac }) => {
					endTime(c, 'encrypt-compute-keys');

					for await (const part of parseMultipartRequest(c.var.bodyClone as Parameters<typeof parseMultipartRequest>[0])) {
						const input = await part.arrayBuffer();

						startTime(c, `${part.filename}|encrypt-cipher`);
						// Actually encrypt
						await encryptContent({
							algorithm: param.algorithm,
							key,
							input,
							inputFormat: 'buffer',
						}).then(({ preamble, cipherBuffer }) => {
							endTime(c, `${part.filename}|encrypt-cipher`);

							startTime(c, `${part.filename}|encrypt-sign`);
							// Sign over IV || data (to account for algorithms that don't have proper validation)
							const mergedBuffer = new Uint8Array(preamble.length + cipherBuffer.length);
							mergedBuffer.set(preamble, 0);
							mergedBuffer.set(cipherBuffer, preamble.length);

							return crypto.subtle.sign({ name: 'HMAC' }, mac, mergedBuffer).then((signature) => {
								endTime(c, `${part.filename}|encrypt-sign`);

								// Append back
								returningCiphertexts.push({
									value: cipherText0('base64', {
										dk_id: bwKey.dk_id,
										algorithm: param.algorithm,
										bitStrength: param.bitStrength,
										preamble,
										cipherBuffer,
										signature: new Uint8Array(signature),
									}),
									filename: part.filename!,
								});
							});
						});
					}
				});

				/**
				 * Update encryption counter
				 *
				 * Potential inconsistency, but can't be resolved until D1 supports transactions
				 * @link https://github.com/cloudflare/workers-sdk/issues/2733
				 */
				c.executionCtx.waitUntil(
					c.var.t_db
						.select({ generation_count: datakeys.generation_count })
						.from(datakeys)
						.where(eq(datakeys.dk_id, sql<D1Blob>`unhex(${bwKey.dk_id.hex})`))
						.limit(1)
						.then((rows) =>
							Promise.all(
								rows.map(async (row) => ({
									...row,
									generation_count: await BufferHelpers.bufferToBigint(row.generation_count),
								})),
							),
						)
						.then(([row]) => {
							if (row) {
								return c.var.t_db
									.update(datakeys)
									.set({
										generation_count: sql<D1Blob>`unhex(${BufferHelpers.bigintToHex(row.generation_count + BigInt(returningCiphertexts.length))})`,
									})
									.where(eq(datakeys.dk_id, sql<D1Blob>`unhex(${bwKey.dk_id.hex})`))
									.limit(1);
							} else {
								throw new Error('Datakey not found');
							}
						}),
				);
			} else {
				return c.json({ success: false, errors: [{ message: 'Matching key not found in datastore', extensions: { code: 500 } }] }, 500);
			}
		}

		return c.json(
			{
				success: returningCiphertexts.length > 0,
				result: returningCiphertexts,
			},
			returningCiphertexts.length > 0 ? 200 : 422,
		);
	} else {
		return c.json({ success: false, errors: [{ message: 'Access Denied: You do not have permission to perform this action', extensions: { code: 403 } }] }, 403);
	}
});

export default app;
