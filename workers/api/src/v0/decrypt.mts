import { BufferHelpers } from '@chainfuse/helpers/buffers';
import { getRandom } from '@cloudflare/containers';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { parseMultipartRequest } from '@mjackson/multipart-parser';
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { hc } from 'hono/client';
import { endTime, startTime } from 'hono/timing';
import { Buffer } from 'node:buffer';
import { createDecipheriv, createHash, createHmac, createSecretKey, hkdf, timingSafeEqual, type CipherKey } from 'node:crypto';
import { promisify } from 'node:util';
import type { ContextVariables, EnvVars } from '~/types.mjs';
import type { routes as containerRoutes } from '~pqc/container/src/index.mjs';
import type { PqcContainerSidecar } from '~pqc/do/index.mjs';
import { datakeys, keyrings } from '~shared/db-preview/schemas/tenant';
import { BitwardenHelper } from '~shared/helpers/bitwarden.mjs';
import { parseCipherText0, type SecretNote } from '~shared/types/bw/index.mjs';
import { EncryptionAlgorithms, KeyAlgorithms } from '~shared/types/crypto/index.mjs';

const app = new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>();

// @ts-expect-error - Hono middleware doesn't need to return when calling await next()
app.use('*', async (c, next) => {
	/**
	 * Check if at least one permission has r_decrypt set to true.
	 * We have to check specifics in the route handler to get the keyring name from fields.
	 */
	if (Object.values(c.var.permissions).some(({ r_decrypt }) => r_decrypt)) {
		await next();
	} else {
		console.error("Token doesn't have permissions");
		return c.json({ success: false, errors: [{ message: 'Access Denied: You do not have permission to perform this action' }] }, 403);
	}
});

const exampleInput = 'Hello world';
const exampleEncryptedData = '0.MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA.QUVTLUdDTQ.MjU2.cmFuZG9tSVY.Y2lwaGVyZGF0YQ.c2lnbmF0dXJl'; // Example ciphertext format

/**
 * @todo refine to restrict bit strength to certain algorithms
 */
const embededInputBase = z.object({
	keyringName: z.string().trim().min(1).toLowerCase().describe('Specifies the name of the key ring to use, case insensitive'),
	outputFormat: z.enum(['base64', 'base64url', 'hex', 'utf8']).describe('Specifies the output encoding').openapi({ example: 'utf8' }),
});

const embededInput = embededInputBase.extend({
	input: z.string().trim().describe('Specifies the encrypted ciphertext data in the format output by cipherText0()').openapi({ example: exampleEncryptedData }),
	reference: z.string().trim().optional().describe('An optional string that will be present in the reference field on the corresponding item in the response, to assist in understanding which result corresponds to a particular input'),
});

const embededOutputBase = z.object({
	reference: z.string().trim().optional().describe('The value of the `reference` field from the corresponding item in the request'),
});

const embededOutput = z.union([
	embededOutputBase.extend({
		value: z.string().trim().describe('The decrypted plaintext, utf8 encoded.').openapi({ example: exampleInput }),
	}),
	embededOutputBase.extend({
		value: z
			.string()
			.trim()
			.base64()
			.describe('The decrypted plaintext, base64 encoded.')
			.openapi({ example: Buffer.from(exampleInput, 'utf8').toString('base64') }),
	}),
	embededOutputBase.extend({
		value: z
			.string()
			.trim()
			.base64url()
			.describe('The decrypted plaintext, base64url encoded.')
			.openapi({ example: Buffer.from(exampleInput, 'utf8').toString('base64url') }),
	}),
	embededOutputBase.extend({
		value: z
			.hex()
			.trim()
			.describe('The decrypted plaintext, hex encoded.')
			.openapi({ example: Buffer.from(exampleInput, 'utf8').toString('hex') }),
	}),
]);

export const embededRoute = createRoute({
	method: 'post',
	path: '/',
	description: 'This endpoint decrypts ciphertext produced by the encrypt endpoint, returning the original plaintext',
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
						.openapi('DecryptEmbedInput'),
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
						.openapi('DecryptEmbedOutput'),
				},
			},
			description: 'Returns the decrypted plaintext',
		},
		403: {
			content: {
				'application/json': {
					schema: z.object({
						success: z.boolean(),
						errors: z.array(
							z.object({
								message: z.string(),
							}),
						),
					}),
				},
			},
			description: 'Access denied',
		},
		500: {
			content: {
				'application/json': {
					schema: z.object({
						success: z.boolean(),
						errors: z.array(
							z.object({
								message: z.string(),
							}),
						),
					}),
				},
			},
			description: 'Internal server error',
		},
	},
});

async function generateKey({ key_type, key_size, hash, privateKey, publicKey, salt, macInfo, algorithm, algorithmSize }: { key_type: KeyAlgorithms; key_size?: number; hash: typeof keyrings.$inferSelect.hash; privateKey: JsonWebKey; publicKey?: JsonWebKey; salt: Buffer; macInfo: Buffer; algorithm: EncryptionAlgorithms; algorithmSize: '128' | '192' | '256' }): Promise<{ key: CipherKey; mac: CipherKey }> {
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

	let keyMaterial: CipherKey;

	/**
	 * If key has native derive key, we'll use it.
	 * Otherwise we'll merge the raw keys (private + public?) and derive key using hkdf
	 */
	switch (key_type) {
		case KeyAlgorithms['RSASSA-PKCS1-v1_5']:
		case KeyAlgorithms['RSA-PSS']:
		case KeyAlgorithms['RSA-OAEP']: {
			let normalizedUsages: readonly KeyUsage[];
			switch (key_type) {
				case KeyAlgorithms['RSASSA-PKCS1-v1_5']:
				case KeyAlgorithms['RSA-PSS']:
					normalizedUsages = ['sign'];
					break;
				case KeyAlgorithms['RSA-OAEP']:
					normalizedUsages = ['encrypt'];
			}

			// Guaranteed private key import
			const importPromises = [
				crypto.subtle.importKey(
					'jwk',
					privateKey,
					{
						name: Object.entries(KeyAlgorithms).find((algo) => algo[1] === key_type)![0],
						hash: normalizedHashName,
					} satisfies RsaHashedImportParams,
					true,
					normalizedUsages,
				),
			];

			// Optional public key import
			if (publicKey)
				importPromises.push(
					crypto.subtle.importKey(
						'jwk',
						publicKey,
						{
							name: Object.entries(KeyAlgorithms).find((algo) => algo[1] === key_type)![0],
							hash: normalizedHashName,
						} satisfies RsaHashedImportParams,
						true,
						normalizedUsages,
					),
				);

			// Merge keys
			const combinedRawKeys = Buffer.concat((await Promise.all(importPromises).then((importedKeys) => Promise.all(importedKeys.map((importedKey) => crypto.subtle.exportKey('raw', importedKey))))).map((rawKey) => Buffer.from(rawKey)));

			keyMaterial = await promisify(hkdf)(hash, combinedRawKeys, salt, Buffer.from(new Uint8Array()), parseInt(algorithmSize) / 8).then((key) => Buffer.from(key));
			break;
		}
		case KeyAlgorithms.ECDSA: {
			let normalizedCurve: undefined | 'P-256' | 'P-384' | 'P-521';
			switch (key_size) {
				case 256:
					normalizedCurve = 'P-256';
					break;
				case 384:
					normalizedCurve = 'P-384';
					break;
				case 521:
					normalizedCurve = 'P-521';
					break;

				default:
					// Lets try to infer some defaults
					switch (normalizedHashName) {
						case 'SHA-256':
							normalizedCurve = 'P-256';
							break;
						case 'SHA-384':
							normalizedCurve = 'P-384';
							break;
						case 'SHA-512':
							normalizedCurve = 'P-521';
							break;
						default:
							throw new Error('Unsupported curve');
					}
					break;
			}

			// Guaranteed private key import
			const importPromises = [
				crypto.subtle.importKey(
					'jwk',
					privateKey,
					{
						name: Object.entries(KeyAlgorithms).find((algo) => algo[1] === key_type)![0],
						namedCurve: normalizedCurve,
					} satisfies EcKeyImportParams,
					false,
					['sign'],
				),
			];

			// Optional public key import
			if (publicKey)
				importPromises.push(
					crypto.subtle.importKey(
						'jwk',
						publicKey,
						{
							name: Object.entries(KeyAlgorithms).find((algo) => algo[1] === key_type)![0],
							namedCurve: normalizedCurve,
						} satisfies EcKeyImportParams,
						false,
						['sign'],
					),
				);

			// Merge keys
			const combinedRawKeys = Buffer.concat((await Promise.all(importPromises).then((importedKeys) => Promise.all(importedKeys.map((importedKey) => crypto.subtle.exportKey('raw', importedKey))))).map((rawKey) => Buffer.from(rawKey)));

			keyMaterial = await promisify(hkdf)(hash, combinedRawKeys, salt, Buffer.from(new Uint8Array()), parseInt(algorithmSize) / 8).then((key) => Buffer.from(key));
			break;
		}
		case KeyAlgorithms['ML-KEM']:
		case KeyAlgorithms['ML-DSA']:
		case KeyAlgorithms['SLH-DSA-SHA2-S']:
		case KeyAlgorithms['SLH-DSA-SHA2-F']:
		case KeyAlgorithms['SLH-DSA-SHAKE-S']:
		case KeyAlgorithms['SLH-DSA-SHAKE-F']: {
			// Guaranteed private key import
			const rawKeys = [Buffer.from(privateKey.d!, 'base64url')];

			// Optional public key import
			if (publicKey?.x) rawKeys.push(Buffer.from(publicKey.x, 'base64url'));

			// Merge keys
			const combinedRawKeys = Buffer.concat(rawKeys);

			keyMaterial = createSecretKey(combinedRawKeys);
			break;
		}
		default:
			throw new Error('Unsupported key type');
	}

	return Promise.all([
		promisify(hkdf)(
			//
			hash,
			keyMaterial,
			salt,
			Buffer.from(new Uint8Array()),
			parseInt(algorithmSize) / 8,
		),
		promisify(hkdf)(
			//
			hash,
			keyMaterial,
			salt,
			macInfo,
			createHash(hash).digest().byteLength,
		),
	]).then(([key, mac]) => ({
		key: Buffer.from(key),
		mac: Buffer.from(mac),
	}));
}

async function decryptContent({ algorithm, algorithmSize, key, ciphertext, containerDo, url }: { algorithm: EncryptionAlgorithms; algorithmSize: '128' | '192' | '256'; key: CipherKey; ciphertext: string; containerDo: DurableObjectNamespace<PqcContainerSidecar>; url: string | URL }) {
	// Parse the ciphertext format to extract components
	const parsedCiphertext = await parseCipherText0(ciphertext);

	switch (algorithm) {
		case EncryptionAlgorithms['AES-GCM']: {
			const decipher = createDecipheriv(`aes-${algorithmSize}-gcm`, key, parsedCiphertext.preamble);

			// For GCM, auth tag is at the end of the cipher buffer
			const authTagLength = 16;
			const actualCipherText = parsedCiphertext.cipherBuffer.subarray(0, -authTagLength);
			const authTag = parsedCiphertext.cipherBuffer.subarray(-authTagLength);

			decipher.setAuthTag(authTag);
			const plainText = Buffer.concat([decipher.update(actualCipherText), decipher.final()]);

			return {
				plainTextBuffer: new Uint8Array(plainText),
			};
		}
		case EncryptionAlgorithms['AES-CBC']: {
			const decipher = createDecipheriv(`aes-${algorithmSize}-cbc`, key, parsedCiphertext.preamble);

			const plainText = Buffer.concat([decipher.update(parsedCiphertext.cipherBuffer), decipher.final()]);

			return {
				plainTextBuffer: new Uint8Array(plainText),
			};
		}
		case EncryptionAlgorithms['AES-CTR']: {
			const decipher = createDecipheriv(`aes-${algorithmSize}-ctr`, key, parsedCiphertext.preamble);

			const plainText = Buffer.concat([decipher.update(parsedCiphertext.cipherBuffer), decipher.final()]);

			return {
				plainTextBuffer: new Uint8Array(plainText),
			};
		}
		case EncryptionAlgorithms['ChaCha20-Poly1305']: {
			return getRandom(containerDo, 1)
				.then((stub) =>
					hc<containerRoutes>(new URL(url).origin, { fetch: stub.fetch.bind(stub) }).decrypt[':algo'].$post({
						param: { algo: 'chacha20-poly1305' },
						json: {
							key: Buffer.from(key as Buffer).toString('base64'),
							chaIv: Buffer.from(parsedCiphertext.preamble).toString('base64'),
							cipherText: Buffer.from(parsedCiphertext.cipherBuffer).toString('base64'),
						},
					}),
				)
				.then((response) => {
					console.debug('container response', response.status, response.statusText);

					if (response.ok) {
						return response.arrayBuffer();
					} else {
						throw new Error(`Error: ${response.status} ${response.statusText}`);
					}
				})
				.then((arrayBuffer) => ({
					plainTextBuffer: new Uint8Array(arrayBuffer),
				}));
		}
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
				})?.r_decrypt,
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

			// Efficient batch retrieve datakeys
			startTime(c, 'db-fetch-datakeys');
			const receivedDatakeys = await c.var
				.t_db()
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
						keyringPermissions.map(({ kr_id }) => sql<Buffer>`unhex(${kr_id.hex})`),
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

			const returningPlaintexts: z.infer<typeof embededOutput>[] = [];

			// Get all the datakeys backed by bitwarden
			const bwDatakeys = receivedDatakeys.filter(({ bw_id }) => bw_id !== undefined).map((datakey) => ({ ...datakey, bw_id: datakey.bw_id! }));

			if (bwDatakeys.length > 0) {
				startTime(c, 'bitwarden-auth');
				const jwt = await BitwardenHelper.identity(c.env.US_BW_SM_ACCESS_TOKEN);
				endTime(c, 'bitwarden-auth');

				const bws = new BitwardenHelper(jwt);

				// Get all the unique keys from bitwarden and parse them into formats needed + carry over db metadata (for filtering purposes)
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
							// Parse the ciphertext to extract algorithm and bit strength
							const parsedCiphertext = await parseCipherText0(allowedInput.input);

							startTime(c, `${allowedInput.reference && `${allowedInput.reference}|`}decrypt-compute-keys`);
							// Compute actual decryption key from data key(s)
							const { key, mac } = await generateKey({
								algorithm: parsedCiphertext.algorithm,
								algorithmSize: parsedCiphertext.bitStrength,
								hash: bwKey.hash,
								key_type: bwKey.key_type,
								key_size: bwKey.key_size ?? undefined,
								salt: Buffer.from(bwKey.salt),
								macInfo: Buffer.from(bwKey.macInfo),
								privateKey: bwKey.private,
								publicKey: bwKey.public,
							});
							endTime(c, `${allowedInput.reference && `${allowedInput.reference}|`}decrypt-compute-keys`);

							startTime(c, `${allowedInput.reference && `${allowedInput.reference}|`}decrypt-verify`);
							// Verify signature before decryption

							// Verify HMAC signature
							const mergedBuffer = new Uint8Array(parsedCiphertext.preamble.length + parsedCiphertext.cipherBuffer.length);
							mergedBuffer.set(parsedCiphertext.preamble, 0);
							mergedBuffer.set(parsedCiphertext.cipherBuffer, parsedCiphertext.preamble.length);

							const computedSignature = createHmac(bwKey.hash, key as Buffer)
								.update(mergedBuffer)
								.digest();

							const signatureValid = timingSafeEqual(computedSignature, parsedCiphertext.signature);

							if (!signatureValid) {
								throw new Error('Invalid signature - ciphertext may have been tampered with');
							}

							endTime(c, `${allowedInput.reference && `${allowedInput.reference}|`}decrypt-verify`);

							startTime(c, `${allowedInput.reference && `${allowedInput.reference}|`}decrypt-cipher`);
							// Actually decrypt
							const { plainTextBuffer } = await decryptContent({
								algorithm: parsedCiphertext.algorithm,
								algorithmSize: parsedCiphertext.bitStrength,
								key,
								ciphertext: allowedInput.input,
								containerDo: c.env.PQC_CONTAINER_SIDECAR,
								url: c.req.url,
							});
							endTime(c, `${allowedInput.reference && `${allowedInput.reference}|`}decrypt-cipher`);

							// Format output according to requested format
							let formattedOutput: string;
							switch (allowedInput.outputFormat) {
								case 'utf8':
									formattedOutput = Buffer.from(plainTextBuffer).toString('utf8');
									break;
								case 'base64':
									formattedOutput = Buffer.from(plainTextBuffer).toString('base64');
									break;
								case 'base64url':
									formattedOutput = Buffer.from(plainTextBuffer).toString('base64url');
									break;
								case 'hex':
									formattedOutput = Buffer.from(plainTextBuffer).toString('hex');
									break;
								default:
									formattedOutput = Buffer.from(plainTextBuffer).toString('utf8');
							}

							// Append back
							returningPlaintexts.push({
								value: formattedOutput,
								reference: allowedInput.reference,
							});
						} else {
							return undefined;
						}
					}),
				);
			}

			return c.json(
				{
					success: returningPlaintexts.length > 0,
					result: returningPlaintexts,
				},
				200,
			);
		} else {
			return c.json({ success: false, errors: [{ message: 'Access Denied: You do not have permission to perform this action' }] }, 403);
		}
	} else {
		const keyring_permissions = Object.entries(c.var.permissions).find(([, keyring_permission]) => keyring_permission.kr_name.toLowerCase() === json.keyringName.toLowerCase());

		if (keyring_permissions) {
			const [kr_id_base64url, keyring_permission] = keyring_permissions;
			const kr_id = await BufferHelpers.uuidConvert(kr_id_base64url);

			startTime(c, 'db-fetch-datakeys');
			const receivedDatakeys = await c.var
				.t_db()
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
				.where(eq(keyrings.kr_id, sql<Buffer>`unhex(${kr_id.hex})`))
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

				// Get all the unique keys from bitwarden and parse them into formats needed + carry over db metadata (for filtering purposes)
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
					// Parse the ciphertext to extract algorithm and bit strength
					const parsedCiphertext = await parseCipherText0(json.input);

					startTime(c, 'decrypt-compute-keys');
					// Compute actual decryption key from data key(s)
					const { key, mac } = await generateKey({
						algorithm: parsedCiphertext.algorithm,
						algorithmSize: parsedCiphertext.bitStrength,
						hash: bwKey.hash,
						key_type: bwKey.key_type,
						key_size: bwKey.key_size ?? undefined,
						salt: Buffer.from(bwKey.salt),
						macInfo: Buffer.from(bwKey.macInfo),
						privateKey: bwKey.private,
						publicKey: bwKey.public,
					});
					endTime(c, 'decrypt-compute-keys');

					startTime(c, 'decrypt-verify');
					// Verify signature before decryption

					// Verify HMAC signature
					const mergedBuffer = new Uint8Array(parsedCiphertext.preamble.length + parsedCiphertext.cipherBuffer.length);
					mergedBuffer.set(parsedCiphertext.preamble, 0);
					mergedBuffer.set(parsedCiphertext.cipherBuffer, parsedCiphertext.preamble.length);

					const computedSignature = createHmac(bwKey.hash, key as Buffer)
						.update(mergedBuffer)
						.digest();

					const signatureValid = timingSafeEqual(computedSignature, parsedCiphertext.signature);

					if (!signatureValid) {
						throw new Error('Invalid signature - ciphertext may have been tampered with');
					}

					endTime(c, 'decrypt-verify');

					startTime(c, 'decrypt-cipher');
					// Actually decrypt
					const { plainTextBuffer } = await decryptContent({
						algorithm: parsedCiphertext.algorithm,
						algorithmSize: parsedCiphertext.bitStrength,
						key,
						ciphertext: json.input,
						containerDo: c.env.PQC_CONTAINER_SIDECAR,
						url: c.req.url,
					});
					endTime(c, 'decrypt-cipher');

					// Format output according to requested format
					let formattedOutput: string;
					switch (json.outputFormat) {
						case 'utf8':
							formattedOutput = Buffer.from(plainTextBuffer).toString('utf8');
							break;
						case 'base64':
							formattedOutput = Buffer.from(plainTextBuffer).toString('base64');
							break;
						case 'base64url':
							formattedOutput = Buffer.from(plainTextBuffer).toString('base64url');
							break;
						case 'hex':
							formattedOutput = Buffer.from(plainTextBuffer).toString('hex');
							break;
						default:
							formattedOutput = Buffer.from(plainTextBuffer).toString('utf8');
					}

					return c.json(
						{
							success: true,
							result: {
								value: formattedOutput,
								reference: json.reference,
							},
						},
						200,
					);
				} else {
					return c.json({ success: false, errors: [{ message: 'Matching key not found in datastore' }] }, 500);
				}
			} else {
				return c.json({ success: false, errors: [{ message: 'Unsupported data store' }] }, 500);
			}
		} else {
			return c.json({ success: false, errors: [{ message: 'Access Denied: You do not have permission to perform this action' }] }, 403);
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
	value: z.string().trim().describe('The decrypted plaintext data.').openapi({ example: exampleInput }),
	filename: z.string().trim(),
});

export const uploadedRoute = createRoute({
	method: 'post',
	path: '/{keyringName}',
	description: 'This endpoint decrypts uploaded files containing ciphertext produced by the encrypt endpoint',
	request: {
		params: z.object({
			keyringName: z.string().trim().min(1).toLowerCase().describe('Specifies the name of the key ring to use, case insensitive'),
		}),
		body: {
			content: {
				'multipart/form-data': {
					schema: uploadedInput.openapi('DecryptUploadInput'),
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
						.openapi('DecryptUploadOutput'),
				},
			},
			description: 'Returns the decrypted plaintext',
		},
		403: {
			content: {
				'application/json': {
					schema: z.object({
						success: z.boolean(),
						errors: z.array(
							z.object({
								message: z.string(),
							}),
						),
					}),
				},
			},
			description: 'Access denied',
		},
		500: {
			content: {
				'application/json': {
					schema: z.object({
						success: z.boolean(),
						errors: z.array(
							z.object({
								message: z.string(),
							}),
						),
					}),
				},
			},
			description: 'Internal server error',
		},
	},
});

app.openapi(uploadedRoute, async (c) => {
	// Needs to be set to a variable or else type isn't inferred
	const param = c.req.valid('param');

	const keyring_permissions = Object.entries(c.var.permissions).find(([, keyring_permission]) => keyring_permission.kr_name.toLowerCase() === param.keyringName.toLowerCase());

	if (keyring_permissions) {
		const returningPlaintexts: z.infer<typeof uploadedOutput>[] = [];

		const [kr_id_base64url, keyring_permission] = keyring_permissions;
		const kr_id = await BufferHelpers.uuidConvert(kr_id_base64url);

		startTime(c, 'db-fetch-datakeys');
		const receivedDatakeys = await c.var
			.t_db()
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
			.where(eq(keyrings.kr_id, sql<Buffer>`unhex(${kr_id.hex})`))
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

			// Get all the unique keys from bitwarden and parse them into formats needed + carry over db metadata (for filtering purposes)
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
				startTime(c, 'decrypt-compute-keys');

				// Type cast because of CF's implementation of Request vs w3c Request
				for await (const part of parseMultipartRequest(c.var.bodyClone as Parameters<typeof parseMultipartRequest>[0])) {
					const ciphertextString = Buffer.from(part.arrayBuffer).toString('utf8');

					// Parse the ciphertext to extract algorithm and bit strength
					const parsedCiphertext = await parseCipherText0(ciphertextString);

					// Compute actual decryption key from data key(s)
					const { key, mac } = await generateKey({
						algorithm: parsedCiphertext.algorithm,
						algorithmSize: parsedCiphertext.bitStrength,
						hash: bwKey.hash,
						key_type: bwKey.key_type,
						key_size: bwKey.key_size ?? undefined,
						salt: Buffer.from(bwKey.salt),
						macInfo: Buffer.from(bwKey.macInfo),
						privateKey: bwKey.private,
						publicKey: bwKey.public,
					});

					endTime(c, 'decrypt-compute-keys');

					startTime(c, `${part.filename}|decrypt-verify`);
					// Verify signature before decryption

					// Verify HMAC signature
					const mergedBuffer = new Uint8Array(parsedCiphertext.preamble.length + parsedCiphertext.cipherBuffer.length);
					mergedBuffer.set(parsedCiphertext.preamble, 0);
					mergedBuffer.set(parsedCiphertext.cipherBuffer, parsedCiphertext.preamble.length);

					const computedSignature = createHmac(bwKey.hash, key).update(mergedBuffer).digest();

					const signatureValid = timingSafeEqual(computedSignature, parsedCiphertext.signature);

					if (!signatureValid) {
						throw new Error(`Invalid signature for file ${part.filename} - ciphertext may have been tampered with`);
					}

					endTime(c, `${part.filename}|decrypt-verify`);

					startTime(c, `${part.filename}|decrypt-cipher`);
					// Actually decrypt
					await decryptContent({
						algorithm: parsedCiphertext.algorithm,
						algorithmSize: parsedCiphertext.bitStrength,
						key,
						ciphertext: ciphertextString,
						containerDo: c.env.PQC_CONTAINER_SIDECAR,
						url: c.req.url,
					}).then(({ plainTextBuffer }) => {
						endTime(c, `${part.filename}|decrypt-cipher`);

						// Format output as UTF-8 for file content
						const formattedOutput = Buffer.from(plainTextBuffer).toString('utf8');

						// Append back
						returningPlaintexts.push({
							value: formattedOutput,
							filename: part.filename!,
						});
					});
				}
			} else {
				return c.json({ success: false, errors: [{ message: 'Matching key not found in datastore' }] }, 500);
			}
		}

		return c.json(
			{
				success: returningPlaintexts.length > 0,
				result: returningPlaintexts,
			},
			200,
		);
	} else {
		return c.json({ success: false, errors: [{ message: 'Access Denied: You do not have permission to perform this action' }] }, 403);
	}
});

export default app;
