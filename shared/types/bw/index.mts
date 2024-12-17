export const BaseBitwardenServer = ['https://bitwarden.com', 'https://bitwarden.eu'] as const;

export interface SecretNote {
	/**
	 * base64 encoded
	 */
	public?: string;
	/**
	 * base64 encoded
	 */
	salt: string;
}

export enum ApiKeyVersions {
	/**
	 * 256 bit secret generated
	 * sha256 hash of secret is stored in db
	 * `0.<base64 api key id>.<base64 secret>`
	 */
	'256base64sha256' = 0,
	/**
	 * 384 bit secret generated
	 * sha384 hash of secret is stored in db
	 * `1.<base64 api key id>.<base64 secret>`
	 */
	'384base64sha384' = 1,
	/**
	 * 512 bit secret generated
	 * sha512 hash of secret is stored in db
	 * `2.<base64 api key id>.<base64 secret>`
	 */
	'512base64sha512' = 2,
}
