import { DurableObject } from 'cloudflare:workers';
import type { JWTPayload } from 'jose';
import { Buffer } from 'node:buffer';
import type { UUID } from 'node:crypto';
import type { EnvVars } from '~/types.mjs';

export namespace BitwardenCloudEndpoints {
	export enum Identity {
		us = 'https://identity.bitwarden.com',
		eu = 'https://identity.bitwarden.eu',
	}
	export enum Api {
		us = 'https://api.bitwarden.com',
		eu = 'https://api.bitwarden.eu',
	}
}

interface ParsedJwt extends JWTPayload {
	scope: ['api.secrets'];
	client_id: UUID;
	sub: UUID;
	type: 'ServiceAccount';
	organization: UUID;
}

interface ProjectResponsEnhanced extends Omit<ProjectResponse, 'id'> {
	id: UUID;
	read: boolean;
	write: boolean;
}

interface SecretsProject {
	id: UUID;
	name: string;
}

export class BitwardenSession extends DurableObject<EnvVars> {
	private access_token: string;
	private orgEncryptionKey: string;

	public async identity(identityEndpoint: BitwardenCloudEndpoints.Identity | string, accessToken: string) {
		const [, uuid, extra] = accessToken.split('.');
		const [secret, encryptionKey] = extra!.split(':');

		const response = await fetch(new URL('connect/token', identityEndpoint), {
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
		});

		if (response.ok) {
			const json = await response.json<{
				access_token: string;
				encrypted_payload: string;
				expires_in: number;
				scope: 'api.secrets';
				token_type: 'Bearer';
			}>();

			// Step 1: Parse the string into an EncString object
			const encString = EncString.fromString(json.encrypted_payload);

			// Step 2: Create the SymmetricCryptoKey
			const accTokenSymmetricKey = await deriveShareableKey(Uint8Array.from(Buffer.from(encryptionKey!, 'base64')), 'accesstoken', 'sm-access-token');
			const symmetricKey = await SymmetricCryptoKey.fromBase64Key(Buffer.from(accTokenSymmetricKey).toString('base64'), 2);

			const decryptedData = await encString.decryptWithKey(symmetricKey);

			const decryptedString = JSON.parse(new TextDecoder().decode(decryptedData)) as { encryptionKey: string };

			this.access_token = json.access_token;
			this.orgEncryptionKey = decryptedString.encryptionKey;
		} else {
			throw new Error('Failed to get token', { cause: await response.text() });
		}
	}
}
