import { decodeJwt, type JWTPayload } from 'jose';
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
					.then((json) => ({
						...json,
						encryptionKey,
						payload: decodeJwt(json.access_token) as ParsedJwt,
					}));
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
}
