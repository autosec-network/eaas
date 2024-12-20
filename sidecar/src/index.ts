import { WorkerEntrypoint } from 'cloudflare:workers';
import { BitwardenHelper } from '../../shared/bitwarden/index.mjs';
import type { EnvVars } from './types.mjs';

export default class extends WorkerEntrypoint<EnvVars> {
	override async fetch() {
		const jwt = await BitwardenHelper.identity(this.env.US_BW_SM_ACCESS_TOKEN);
		const bws = new BitwardenHelper(jwt);
		const { secrets: secretsList } = await bws.secretsAndProjects();
		const secrets = await bws.getSecrets(secretsList.map((secret) => secret.id));

		function redact(str: string, visibleChars: number = 5) {
			const redactedLength = str.length - 2 * visibleChars;
			const redactedPart = '.'.repeat(redactedLength);
			return [str.slice(0, visibleChars), redactedPart, str.slice(-visibleChars)].join('');
		}

		return new Response(
			JSON.stringify({
				jwt: {
					access_token: jwt.access_token,
					orgEncryptionKey: redact(jwt.orgEncryptionKey),
				},
				secrets: await Promise.all(
					secrets.map(async (secret) => ({
						id: secret.id,
						organizationId: secret.organizationId,
						projectId: secret.projects[0]?.id,
						key: secret.key,
						decryptedKey: await bws.decryptSecret(secret.key),
						value: secret.value,
						decryptedValue: await bws.decryptSecret(secret.value),
						note: secret.note,
						decryptedNote: await bws.decryptSecret(secret.note),
						creationDate: secret.creationDate,
						revisionDate: secret.revisionDate,
					})),
				),
			}),
			{ headers: { 'Content-Type': 'application/json' } },
		);
	}
}
