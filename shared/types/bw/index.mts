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
export function cipherText0(outputFormat: 'base64' | 'base64url' | 'hex', { dk_id, algorithm, bitStrength, preamble, cipherBuffer, signature }: { dk_id: UuidExport; preamble: Uint8Array; algorithm: EncryptionAlgorithms; bitStrength: '128' | '192' | '256'; cipherBuffer: ArrayBufferLike; signature: ArrayBufferLike }) {
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
