import { Buffer } from 'node:buffer';
import { DOJurisdictions } from 'types';
import { BitwardenCloudEndpoints } from 'types/bw';
import type { EnvVars } from '~/types.mjs';

// ─── Bitwarden helpers ───────────────────────────────────────────────────────

export function bwEndpoints(jurisdiction: DOJurisdictions | null) {
	const isEu = jurisdiction === DOJurisdictions['The European Union'];
	return {
		base: isEu ? BitwardenCloudEndpoints.Api.eu : BitwardenCloudEndpoints.Api.us,
		authentication: isEu ? BitwardenCloudEndpoints.Identity.eu : BitwardenCloudEndpoints.Identity.us,
	};
}

export function bwAccessToken(env: EnvVars, jurisdiction: DOJurisdictions | null) {
	return jurisdiction === DOJurisdictions['The European Union'] ? env.EU_BW_SM_ACCESS_TOKEN : env.US_BW_SM_ACCESS_TOKEN;
}

/**
 * Store a newly-generated noise static private key in the root Bitwarden vault.
 * Returns the Bitwarden secret UUID for storage as `noise_bw` tenant property.
 */
export async function storeNoisePrivateKeyInBw(ctx: { waitUntil: (p: Promise<unknown>) => void }, env: EnvVars, jurisdiction: DOJurisdictions | null, tenantIdBase64url: string, privateKey: ArrayBuffer): Promise<string> {
	const bwDoId = jurisdiction ? env.BITWARDEN_SESSION.jurisdiction(jurisdiction).newUniqueId() : env.BITWARDEN_SESSION.newUniqueId();
	const bwStub = env.BITWARDEN_SESSION.get(bwDoId);

	try {
		await bwStub.init({
			t_jurisdiction: null,
			t_do_id: null,
			endpoints: bwEndpoints(jurisdiction),
		});

		const rootAccessToken = bwAccessToken(env, jurisdiction);
		await bwStub.auth(rootAccessToken);

		const privKeyBase64url = Buffer.from(privateKey).toString('base64url');
		const secret = await bwStub.setSecret({
			projectId: jurisdiction === DOJurisdictions['The European Union'] ? env.EU_BW_SM_PROJECT_ID : env.US_BW_SM_PROJECT_ID,
			key: await bwStub.encryptSecret(rootAccessToken, [tenantIdBase64url, 'n'].join('/')),
			value: await bwStub.encryptSecret(rootAccessToken, privKeyBase64url),
			note: '',
		});

		return secret.id;
	} finally {
		ctx.waitUntil(bwStub.nuke('Noise key store session ended'));
	}
}
