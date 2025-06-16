import type { EncryptionAlgorithms } from '../crypto/index.mjs';
import type { UuidExport } from '../d1/index.mjs';

export const BaseBitwardenServer = ['https://bitwarden.com', 'https://bitwarden.eu'] as const;

export interface SecretNote {
	/**
	 * base64 encoded
	 */
	public?: JsonWebKey;
	/**
	 * base64url encoded
	 */
	salt: string;
	/**
	 * base64url encoded
	 */
	macInfo: string;
}

export enum ApiKeyVersions {
	/**
	 * 256 bit secret generated
	 * sha256 hash of secret is stored in db
	 * `0.<base64url api key id>.<base64url secret>`
	 */
	'256base64urlSha256' = 0,
	/**
	 * 384 bit secret generated
	 * sha384 hash of secret is stored in db
	 * `1.<base64url api key id>.<base64url secret>`
	 */
	'384base64urlSha384' = 1,
	/**
	 * 512 bit secret generated
	 * sha512 hash of secret is stored in db
	 * `2.<base64url api key id>.<base64url secret>`
	 */
	'512base64urlSha512' = 2,
}

export enum CipherTextVersions {
	/**
	 * `0.<dk_id>.<algorithm>.<bitStrength>.<preamble>.<cipher text>.<mac>`
	 */
	dkKrPreambleCipherSignature = 0,
}

// Ensure they are always in the correct order
export function cipherText0(outputFormat: 'base64' | 'base64url' | 'hex', { dk_id, algorithm, bitStrength, preamble, cipherBuffer, signature }: { dk_id: UuidExport; preamble: Uint8Array; algorithm: EncryptionAlgorithms; bitStrength: '128' | '192' | '256'; cipherBuffer: Uint8Array; signature: Uint8Array }) {
	return [
		CipherTextVersions.dkKrPreambleCipherSignature,
		// UuidExport already has formats as properties
		dk_id[outputFormat],
		Buffer.from(algorithm).toString(outputFormat),
		Buffer.from(bitStrength).toString(outputFormat),
		Buffer.from(preamble).toString(outputFormat),
		Buffer.from(cipherBuffer).toString(outputFormat),
		Buffer.from(signature).toString(outputFormat),
	].join('.');
}

export async function parseCipherText0(cipherText: string): Promise<{ dk_id: UuidExport; algorithm: EncryptionAlgorithms; bitStrength: '128' | '192' | '256'; preamble: Uint8Array; cipherBuffer: Uint8Array; signature: Uint8Array }> {
	const parts = cipherText.split('.');

	if (parts.length !== 7) {
		throw new Error('Invalid ciphertext format');
	}

	const [version, dk_id_str, algorithm_str, bitStrength_str, preamble_str, cipherBuffer_str, signature_str] = parts;

	if (!version || parseInt(version, 10) !== 0) {
		throw new Error('Unsupported ciphertext version');
	}

	if (!dk_id_str || !algorithm_str || !bitStrength_str || !preamble_str || !cipherBuffer_str || !signature_str) {
		throw new Error('Invalid ciphertext format - missing components');
	}

	// Determine the encoding format based on the characters used
	let encoding: 'base64' | 'base64url' | 'hex' = 'base64';
	if (dk_id_str.includes('-') || dk_id_str.includes('_')) {
		encoding = 'base64url';
	} else if (/^[0-9a-fA-F]+$/.test(dk_id_str)) {
		encoding = 'hex';
	}

	return import('@chainfuse/helpers/buffers').then(async ({ BufferHelpers }) => ({
		dk_id: await BufferHelpers.uuidConvert(dk_id_str),
		algorithm: Buffer.from(algorithm_str, encoding).toString('utf8') as EncryptionAlgorithms,
		bitStrength: Buffer.from(bitStrength_str, encoding).toString('utf8') as '128' | '192' | '256',
		preamble: new Uint8Array(Buffer.from(preamble_str, encoding)),
		cipherBuffer: new Uint8Array(Buffer.from(cipherBuffer_str, encoding)),
		signature: new Uint8Array(Buffer.from(signature_str, encoding)),
	}));
}
