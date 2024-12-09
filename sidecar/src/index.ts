import { WorkerEntrypoint } from 'cloudflare:workers';
import { BitwardenHelper, EncString, SymmetricCryptoKey } from './bitwarden.mjs';
import type { EnvVars } from './types';

export default class extends WorkerEntrypoint<EnvVars> {
	override async fetch() {
		const jwt = await BitwardenHelper.identity(this.env.BW_SM_ACCESS_TOKEN);
		const bws = new BitwardenHelper(jwt.access_token);
		const { secrets: secretsList } = await bws.secretsAndProjects();
		const secrets = await bws.getSecrets(secretsList.map((secret) => secret.id));

		const decrypt = async (encryptedText: string) => {
			// Step 1: Parse the string into an EncString object
			const encString = EncString.fromString(encryptedText);

			// Step 2: Create the SymmetricCryptoKey
			const symmetricKey = await SymmetricCryptoKey.fromBase64Key(jwt.orgEncryptionKey, encString.encType as 0 | 1 | 2);

			const decryptedData = await encString.decryptWithKey(symmetricKey);

			const decryptedString = new TextDecoder().decode(decryptedData);

			return decryptedString;
		};

		return new Response(
			JSON.stringify({
				jwt,
				secrets: await Promise.all(
					secrets.map(async (secret) => ({
						id: secret.id,
						organizationId: secret.organizationId,
						projectId: secret.projects[0]?.id,
						key: secret.key,
						decryptedKey: await decrypt(secret.key),
						value: secret.value,
						decryptedValue: await decrypt(secret.value),
						note: secret.note,
						decryptedNote: await decrypt(secret.note),
						creationDate: secret.creationDate,
						revisionDate: secret.revisionDate,
					})),
				),
			}),
			{ headers: { 'Content-Type': 'application/json' } },
		);
	}
}
