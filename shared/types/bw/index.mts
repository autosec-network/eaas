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
