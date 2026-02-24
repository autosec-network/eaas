import type { JsonWebKey } from 'node:crypto';

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
