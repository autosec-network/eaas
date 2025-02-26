import { WorkerEntrypoint } from 'cloudflare:workers';
import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import type { EnvVars } from '~/types.mjs';
import { BitwardenHelper } from '~shared/helpers/bitwarden.mjs';

export default class extends WorkerEntrypoint<EnvVars> {
	override async fetch() {
		const jwt = await BitwardenHelper.identity(this.env.US_BW_SM_ACCESS_TOKEN);
		const bws = new BitwardenHelper(jwt);
		const { secrets: secretsList } = await bws.getSecretsAndProjects();
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
					secrets.map(async (secret) => {
						const decryptedKey = await bws.decryptSecret(secret.key, true);
						const decryptedValue = await bws.decryptSecret(secret.value, true);
						const decryptedNote = await bws.decryptSecret(secret.note, true);

						return {
							id: secret.id,
							organizationId: secret.organizationId,
							projectId: secret.projects[0]?.id,
							key: secret.key,
							decryptedKey: decryptedKey.data,
							reecryptedKey: timingSafeEqual(Buffer.from(secret.key), Buffer.from(await bws.encryptSecret(decryptedKey.data, decryptedKey.iv))),
							value: secret.value,
							decryptedValue: decryptedValue.data,
							reecryptedValue: timingSafeEqual(Buffer.from(secret.value), Buffer.from(await bws.encryptSecret(decryptedValue.data, decryptedValue.iv))),
							note: secret.note,
							decryptedNote: decryptedNote.data,
							reecryptedNote: timingSafeEqual(Buffer.from(secret.note), Buffer.from(await bws.encryptSecret(decryptedNote.data, decryptedNote.iv))),
							creationDate: secret.creationDate,
							revisionDate: secret.revisionDate,
						};
					}),
				),
			}),
			{ headers: { 'Content-Type': 'application/json' } },
		);
	}
}
