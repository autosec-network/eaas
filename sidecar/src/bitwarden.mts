import { decodeJwt, type JWTPayload } from 'jose';
import { Buffer } from 'node:buffer';
import type { UUID } from './types';

interface ParsedJwt extends JWTPayload {
	scope: ['api.secrets'];
	client_id: UUID;
	sub: UUID;
	type: 'ServiceAccount';
	organization: UUID;
}

interface SecretsProject {
	id: UUID;
	name: string;
}

export class BitwardenHelper {
	private readonly jwt: string;

	constructor(jwt: string) {
		this.jwt = jwt;
	}

	public static identity(accessToken: string) {
		const [, uuid, extra] = accessToken.split('.');
		const [secret, encryptionKey] = extra!.split(':');

		return fetch(new URL('connect/token', 'https://identity.bitwarden.com'), {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams({
				scope: 'api.secrets',
				client_id: uuid!,
				client_secret: secret!,
				grant_type: 'client_credentials',
			}),
		}).then(async (response) => {
			if (response.ok) {
				return response
					.json<{
						access_token: string;
						encrypted_payload: string;
						expires_in: number;
						scope: 'api.secrets';
						token_type: 'Bearer';
					}>()
					.then(async (json) => {
						// Step 1: Parse the string into an EncString object
						const encString = EncString.fromString(json.encrypted_payload);

						// Step 2: Create the SymmetricCryptoKey
						const accTokenSymmetricKey = await deriveShareableKey(Uint8Array.from(Buffer.from(encryptionKey!, 'base64')), 'accesstoken', 'sm-access-token');
						const symmetricKey = await SymmetricCryptoKey.fromBase64Key(Buffer.from(accTokenSymmetricKey).toString('base64'), 2);

						const decryptedData = await encString.decryptWithKey(symmetricKey);

						const decryptedString = JSON.parse(new TextDecoder().decode(decryptedData)) as { encryptionKey: string };

						return {
							access_token: json.access_token,
							orgEncryptionKey: decryptedString.encryptionKey,
						};
					});
			} else {
				throw new Error('Failed to get token', { cause: await response.text() });
			}
		});
	}

	public secretsAndProjects(orgId: UUID = (decodeJwt(this.jwt) as ParsedJwt)['organization']) {
		return fetch(new URL(['organizations', orgId, 'secrets'].join('/'), 'https://api.bitwarden.com'), {
			headers: {
				Authorization: `Bearer ${this.jwt}`,
			},
		}).then(async (response) => {
			if (response.ok) {
				return response
					.json<{
						object: string;
						projects: SecretsProject[];
						secrets: {
							creationDate: string;
							id: UUID;
							key: string;
							organizationId: UUID;
							projects: SecretsProject[];
							read: boolean;
							revisionDate: string;
							write: boolean;
						}[];
					}>()
					.then(({ projects, secrets }) => ({ projects, secrets }));
			} else {
				throw new Error('Failed to get secrets and projects', { cause: await response.text() });
			}
		});
	}

	public getSecrets(secretIds: UUID[]) {
		if (secretIds.length > 0) {
			return fetch(new URL(['secrets', 'get-by-ids'].join('/'), 'https://api.bitwarden.com'), {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${this.jwt}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					ids: secretIds,
				}),
			}).then(async (response) => {
				if (response.ok) {
					return response
						.json<{
							continuationToken: string;
							data: {
								creationDate: string;
								id: UUID;
								key: string;
								note: string;
								object: string;
								organizationId: UUID;
								projects: SecretsProject[];
								revisionDate: string;
								value: string;
							}[];
							object: 'list';
						}>()
						.then((json) => json.data);
				} else {
					throw new Error('Failed to get secrets and projects', { cause: await response.text() });
				}
			});
		} else {
			throw new Error('No secret IDs provided');
		}
	}
}

/**
 * Types and utilities for working with EncString in a manner similar to the provided Rust code,
 * but implemented in TypeScript using the Web Crypto API. This code assumes:
 *
 * - Node.js v18+ environment with `globalThis.crypto` available.
 * - Use of AES-CBC and HMAC-SHA256 for encryption/decryption and integrity.
 * - SymmetricCryptoKey is represented as keys derived from base64-encoded raw key material.
 * - Base64 encoding/decoding uses `Buffer` from `node:buffer`.
 *
 * NOTE: The actual encryption/decryption logic will differ from the Rust code since the Rust code
 * uses its own AES/HMAC implementations and data structures, while here we rely on the Web Crypto API.
 * Ensure keys and inputs align with what the Rust code expects.
 */

/** Represents a symmetric key for encryption/decryption and optional MAC. */
export class SymmetricCryptoKey {
	public encKey: CryptoKey;
	public macKey?: CryptoKey; // optional, required for variants 1 and 2

	constructor(encKey: CryptoKey, macKey?: CryptoKey) {
		this.encKey = encKey;
		this.macKey = macKey;
	}

	/**
	 * Given a base64-encoded string containing a 32-byte key or a combined key,
	 * derive `encKey` and optionally `macKey`.
	 *
	 * For variant 1: The 32-byte key is split into two 16-byte segments:
	 *  - first 16 bytes: encryption key (AES-128)
	 *  - last 16 bytes: HMAC key
	 *
	 * For variant 0: Only AES-256 key is used, no MAC key.
	 * For variant 2: A 32-byte AES-256 key and a separate 32-byte MAC key are expected.
	 *
	 * Adjust logic as needed for your actual key material layout.
	 */
	static async fromBase64Key(keyB64: string, variant: 0 | 1 | 2): Promise<SymmetricCryptoKey> {
		const keyRaw = Buffer.from(keyB64, 'base64');
		if (variant === 0) {
			// Expect a 32-byte key for AES-256
			if (keyRaw.length !== 32) {
				throw new Error('Invalid key length for variant 0. Expected 32 bytes.');
			}
			const encKey = await crypto.subtle.importKey('raw', keyRaw, { name: 'AES-CBC', length: 256 }, false, ['encrypt', 'decrypt']);
			return new SymmetricCryptoKey(encKey);
		} else if (variant === 1) {
			// 32-byte key total, 16 bytes for AES-128 and 16 bytes for HMAC
			if (keyRaw.length !== 32) {
				throw new Error('Invalid key length for variant 1. Expected 32 bytes.');
			}
			const encKeyRaw = keyRaw.slice(0, 16);
			const macKeyRaw = keyRaw.slice(16, 32);
			const encKey = await crypto.subtle.importKey('raw', encKeyRaw, { name: 'AES-CBC', length: 128 }, false, ['encrypt', 'decrypt']);
			const macKey = await crypto.subtle.importKey('raw', macKeyRaw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
			return new SymmetricCryptoKey(encKey, macKey);
		} else {
			// variant 2: keyRaw expected: 64 bytes (32 for AES-256, 32 for HMAC)
			if (keyRaw.length !== 64) {
				throw new Error('Invalid key length for variant 2. Expected 64 bytes.');
			}
			const encKeyRaw = keyRaw.slice(0, 32);
			const macKeyRaw = keyRaw.slice(32, 64);
			const encKey = await crypto.subtle.importKey('raw', encKeyRaw, { name: 'AES-CBC', length: 256 }, false, ['encrypt', 'decrypt']);
			const macKey = await crypto.subtle.importKey('raw', macKeyRaw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
			return new SymmetricCryptoKey(encKey, macKey);
		}
	}
}

/** Utility functions for base64 encoding/decoding */
function b64decode(str: string): Uint8Array {
	return new Uint8Array(Buffer.from(str, 'base64'));
}
function b64encode(buf: Uint8Array): string {
	return Buffer.from(buf).toString('base64');
}

/**
 * EncString variants:
 * - 0: AesCbc256_B64 { iv, data }
 * - 1: AesCbc128_HmacSha256_B64 { iv, mac, data }
 * - 2: AesCbc256_HmacSha256_B64 { iv, mac, data }
 *
 * This class stores and manipulates the encoded form. It can parse from string/buffer and
 * serialize back to string/buffer. It can also encrypt/decrypt using provided keys.
 */
export class EncString {
	encType: number; // 0,1,2
	iv: Uint8Array;
	data: Uint8Array;
	mac?: Uint8Array;

	constructor(encType: number, iv: Uint8Array, data: Uint8Array, mac?: Uint8Array) {
		this.encType = encType;
		this.iv = iv;
		this.data = data;
		this.mac = mac;
	}

	/** Parse from a string like: `encType.iv|data` or `encType.iv|data|mac` */
	static fromString(s: string): EncString {
		const [encTypeStr, remainder] = s.split('.', 2);
		if (!encTypeStr || remainder === undefined) {
			throw new Error(`Invalid EncString format`);
		}
		const parts = remainder.split('|');
		const encType = Number(encTypeStr);

		if (encType === 0 && parts.length === 2) {
			const iv = b64decode(parts[0]!);
			const data = b64decode(parts[1]!);
			if (iv.length !== 16) {
				throw new Error('Invalid IV length for variant 0');
			}
			return new EncString(encType, iv, data);
		} else if ((encType === 1 || encType === 2) && parts.length === 3) {
			const iv = b64decode(parts[0]!);
			const data = b64decode(parts[1]!);
			const mac = b64decode(parts[2]!);
			if (iv.length !== 16) {
				throw new Error('Invalid IV length for variant 1/2');
			}
			if (mac.length !== 32) {
				throw new Error('Invalid MAC length for variant 1/2');
			}
			return new EncString(encType, iv, data, mac);
		} else {
			throw new Error(`Invalid EncString: type ${encTypeStr} with ${parts.length} parts`);
		}
	}

	/** Convert to the string format: `encType.iv|data` or `encType.iv|data|mac` */
	toString(): string {
		const parts: string[] = [b64encode(this.iv), b64encode(this.data)];
		if (this.encType === 1 || this.encType === 2) {
			if (!this.mac) {
				throw new Error('MAC missing for variant 1/2');
			}
			parts.push(b64encode(this.mac));
		}
		return `${this.encType}.${parts.join('|')}`;
	}

	/** Parse from a binary buffer: [encType, ...iv, ...mac?, ...data] */
	static fromBuffer(buf: Uint8Array): EncString {
		if (buf.length < 1) {
			throw new Error('Buffer too short');
		}
		const encType = buf[0];
		if (encType === 0) {
			// 1 + 16 + data
			if (buf.length < 1 + 16) throw new Error('Buffer too short for variant 0');
			const iv = buf.slice(1, 17);
			const data = buf.slice(17);
			return new EncString(encType, iv, data);
		} else if (encType === 1 || encType === 2) {
			// 1 + 16 + 32 + data
			if (buf.length < 1 + 16 + 32) throw new Error(`Buffer too short for variant ${encType}`);
			const iv = buf.slice(1, 17);
			const mac = buf.slice(17, 49);
			const data = buf.slice(49);
			return new EncString(encType, iv, data, mac);
		} else {
			throw new Error(`Invalid encType ${encType}`);
		}
	}

	/** Convert to binary buffer */
	toBuffer(): Uint8Array {
		let arr: Uint8Array;
		if (this.encType === 0) {
			arr = new Uint8Array(1 + 16 + this.data.length);
			arr[0] = this.encType;
			arr.set(this.iv, 1);
			arr.set(this.data, 17);
		} else {
			if (!this.mac) {
				throw new Error('MAC missing for variant 1/2');
			}
			arr = new Uint8Array(1 + 16 + 32 + this.data.length);
			arr[0] = this.encType;
			arr.set(this.iv, 1);
			arr.set(this.mac, 17);
			arr.set(this.data, 49);
		}
		return arr;
	}

	/**
	 * Encrypt data into variant 2 (AES256 + HMAC-SHA256).
	 * Adjust as needed for other variants.
	 */
	static async encryptAes256Hmac(dataDec: Uint8Array, key: SymmetricCryptoKey): Promise<EncString> {
		if (!key.macKey) {
			throw new Error('MAC key required for variant 2 encryption');
		}
		const iv = crypto.getRandomValues(new Uint8Array(16));
		const encData = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key.encKey, dataDec);
		const data = new Uint8Array(encData);

		// Compute MAC over IV || data
		const macData = new Uint8Array(iv.length + data.length);
		macData.set(iv, 0);
		macData.set(data, iv.length);

		const macBuf = await crypto.subtle.sign('HMAC', key.macKey, macData);
		const mac = new Uint8Array(macBuf);

		return new EncString(2, iv, data, mac);
	}

	/** Decrypt data for all variants */
	async decryptWithKey(key: SymmetricCryptoKey): Promise<Uint8Array> {
		if (this.encType === 0) {
			// AES-256 no MAC
			if (key.macKey) {
				// If MAC key is present, we must fail per original logic
				throw new Error('MacNotProvided');
			}
			const decData = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: this.iv }, key.encKey, this.data);
			return new Uint8Array(decData);
		} else if (this.encType === 1) {
			// AES-128 + HMAC-SHA256
			// Key expected to be split 16 bytes for AES, 16 for HMAC
			// Here we assume `key.encKey` and `key.macKey` were derived accordingly.
			if (!key.macKey) {
				throw new Error('Missing MAC key for variant 1');
			}

			// Verify MAC
			const macData = new Uint8Array(this.iv.length + this.data.length);
			macData.set(this.iv, 0);
			macData.set(this.data, this.iv.length);

			const valid = await crypto.subtle.verify('HMAC', key.macKey, this.mac!, macData);
			if (!valid) {
				throw new Error('Invalid MAC');
			}

			const decData = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: this.iv }, key.encKey, this.data);
			return new Uint8Array(decData);
		} else if (this.encType === 2) {
			// AES-256 + HMAC-SHA256
			if (!key.macKey) {
				throw new Error('InvalidMac');
			}

			// Verify MAC
			const macData = new Uint8Array(this.iv.length + this.data.length);
			macData.set(this.iv, 0);
			macData.set(this.data, this.iv.length);

			const valid = await crypto.subtle.verify('HMAC', key.macKey, this.mac!, macData);
			if (!valid) {
				throw new Error('Invalid MAC');
			}

			const decData = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: this.iv }, key.encKey, this.data);
			return new Uint8Array(decData);
		} else {
			throw new Error(`Invalid encType ${this.encType}`);
		}
	}

	/** Encrypt data (Uint8Array) with a symmetric key into variant 2 by default */
	static async encryptWithKey(data: Uint8Array, key: SymmetricCryptoKey): Promise<EncString> {
		// For demonstration, always produce variant 2 (AES256 + HMAC)
		return EncString.encryptAes256Hmac(data, key);
	}

	/** Example convenience methods for strings */
	static async encryptStringWithKey(str: string, key: SymmetricCryptoKey): Promise<EncString> {
		return EncString.encryptWithKey(new TextEncoder().encode(str), key);
	}

	async decryptToString(key: SymmetricCryptoKey): Promise<string> {
		const decBytes = await this.decryptWithKey(key);
		return new TextDecoder().decode(decBytes);
	}
}

/**
 * HKDF Expand using SHA-256.
 * @param key - The derived secret (PRK) as a Uint8Array.
 * @param info - Optional context and application-specific information.
 * @param outputLength - Desired length of the output keying material.
 * @returns Expanded key as a Uint8Array.
 */
export async function hkdfExpand(key: Uint8Array, info: string | null, outputLength: number): Promise<Uint8Array> {
	const infoBytes = info ? new TextEncoder().encode(info) : new Uint8Array();
	const output = new Uint8Array(outputLength);
	const hashLength = 32; // SHA-256 output length
	const iterations = Math.ceil(outputLength / hashLength);

	let t = new Uint8Array(0);
	for (let i = 0; i < iterations; i++) {
		const hmac = await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), new Uint8Array([...t, ...infoBytes, i + 1]));
		t = new Uint8Array(hmac);
		output.set(t.slice(0, Math.min(hashLength, outputLength - i * hashLength)), i * hashLength);
	}

	return output;
}

/**
 * Derive a SymmetricCryptoKey using HKDF with SHA-256.
 * @param secret - The 16-byte secret as a Uint8Array.
 * @param name - The name (e.g., "accesstoken") as a string.
 * @param info - Optional additional context for HKDF.
 * @returns The derived key as a Uint8Array.
 */
export async function deriveShareableKey(secret: Uint8Array, name: string, info: string | null): Promise<Uint8Array> {
	// Create the initial hash (PRK) using HMAC-SHA256
	const prk = await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', new TextEncoder().encode(`bitwarden-${name}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), secret);

	// Expand the PRK using HKDF to generate the final key
	return hkdfExpand(new Uint8Array(prk), info, 64); // Output length: 64 bytes
}
