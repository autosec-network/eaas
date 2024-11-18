import { decodeJwt, type JWTPayload } from 'jose';
import type { UUID } from './types';

interface ParsedJwt extends JWTPayload {
	scope: ['api.secrets'];
	client_id: UUID;
	sub: UUID;
	type: 'ServiceAccount';
	organization: UUID;
}

export class BitwardenHelper {
	public static identity(accessToken: string) {
		const [, uuid, extra] = accessToken.split('.');
		const [secret] = extra!.split(':');

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
					.then((json) => ({
						access_token: json.access_token,
						payload: decodeJwt(json.access_token) as ParsedJwt,
					}));
			} else {
				throw new Error('Failed to get token', { cause: await response.text() });
			}
		});
	}
}
