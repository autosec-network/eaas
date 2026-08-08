import { server$ } from '@builder.io/qwik-city';
import type { DOJurisdictions } from 'types';
import { isLocal, resolveDoStub } from '~/helpers/do-proxy';

/**
 * List the projects a Bitwarden Secrets Manager access token can see, decrypted.
 *
 * Called from the browser as the customer types their token, so it runs against credentials that aren't ours and may well be wrong - every failure collapses into one opaque message carrying only the session id, because the exception underneath can quote the token back.
 *
 * Shared by onboarding and the vault settings page: both let a customer point us at a Bitwarden organization, and a second copy of this would be a second place for the "never echo the token" rule to be forgotten.
 */
export const getProjects = server$(async function (jurisdiction: DOJurisdictions | null, baseEndpoint: string, authEndpoint: string, apiKey: string) {
	// An id minted by the local `workerd` namespace isn't valid for the deployed one the proxy resolves against (`idFromString` throws "Invalid Durable Object ID"), so when proxying, mint it on the proxy — which can also apply the jurisdiction workerd doesn't support.
	const useProxy = isLocal(this.platform) && !!this.platform.env.BITWARDEN_SESSION_PROXY;
	const bwId = useProxy ? await this.platform.env.BITWARDEN_SESSION_PROXY!.newUniqueId(jurisdiction ?? undefined) : (jurisdiction ? this.platform.env.BITWARDEN_SESSION.jurisdiction(jurisdiction) : this.platform.env.BITWARDEN_SESSION).newUniqueId().toString();
	const doStub = resolveDoStub(this.platform, this.platform.env.BITWARDEN_SESSION, this.platform.env.BITWARDEN_SESSION_PROXY, { id: bwId, jurisdiction: jurisdiction ?? undefined });

	try {
		await doStub.init({ t_jurisdiction: null, t_do_id: null, endpoints: { base: baseEndpoint, authentication: authEndpoint } });
		await doStub.auth(apiKey);
		const projects = await doStub.getProjects();

		return Promise.all(
			projects
				.sort((a, b) => new Date(b.revisionDate).getTime() - new Date(a.revisionDate).getTime())
				.map(async ({ id, name }) => ({
					id,
					name: await doStub.decryptSecret(apiKey, name),
				})),
		);
	} catch (error) {
		console.error('Error fetching projects', error);
		// eslint-disable-next-line preserve-caught-error
		throw new Error(`Unable to fetch projects. Attempt ${bwId}`);
	} finally {
		this.platform.ctx.waitUntil(doStub.nuke('Session ended'));
	}
});
