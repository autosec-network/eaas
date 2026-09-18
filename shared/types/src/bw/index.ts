import type { JsonWebKey } from 'node:crypto';

export namespace BitwardenCloudEndpoints {
	export enum Identity {
		us = 'https://vault.bitwarden.com/identity/connect/token',
		eu = 'https://vault.bitwarden.eu/identity/connect/token',
	}
	export enum Api {
		us = 'https://vault.bitwarden.com/api/',
		eu = 'https://vault.bitwarden.eu/api/',
	}
}

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
	 * `0.<dk_id>.<algorithm>.<bitStrength>.<preamble>.<frame>.<frame>…` - one or more frames, each independently authenticated.
	 *
	 * A frame's bytes are `<final flag (1 byte)><cipher><mac>`, and its `mac` is an HMAC over `<header><preamble><frame index, u64 big-endian><final flag><cipher>` where `<header>` is the ASCII `0.<dk_id>.<algorithm>.<bitStrength>` prefix. The final frame of an AEAD algorithm carries that algorithm's authentication tag as the last 16 bytes of its `<cipher>`.
	 *
	 * Framing is what lets a decrypt verify before it releases: a reader authenticates each frame on arrival and only then writes that frame's plaintext out, instead of streaming an entire unverified payload and discovering at the very end that the message was forged. Binding the frame index and the final flag into each `mac` is what makes reordering, splicing and truncation detectable - a reader that reaches the end of the stream without a frame flagged final rejects the message.
	 */
	dkKrPreambleFramedCipher = 0,
}
