import { server$ } from '@builder.io/qwik-city';
import { MAX_BITWARDEN_SESSION_TASKS } from 'helpers/bitwarden-sessions';
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
		// No tenant exists yet at this point (this runs while a customer is still typing a token, before either onboarding or a vault-settings save has committed anything), so there's nothing for the session to audit-log against - and nothing to pool it under either, which is why this one is still opened and nuked by hand. See `BitwardenSession.initOptions.t_id`'s doc comment.
		await doStub.init({ t_jurisdiction: null, t_do_id: null, t_id: null, u_id: null, ak_id: null, endpoints: { base: baseEndpoint, authentication: authEndpoint } });
		await doStub.auth(apiKey);
		const projects = await doStub.getProjects();

		// Decrypted {@link MAX_BITWARDEN_SESSION_TASKS} at a time - an organization with more projects than that would otherwise fan out past what one session runs at once and start being turned away by its own request
		const chunks = projects
			.sort((a, b) => new Date(b.revisionDate).getTime() - new Date(a.revisionDate).getTime())
			.reduce<(typeof projects)[number][][]>((acc, project, index) => {
				if (index % MAX_BITWARDEN_SESSION_TASKS === 0) acc.push([]);
				acc[acc.length - 1]!.push(project);
				return acc;
			}, []);

		// Awaited here rather than returned directly: `finally` below runs the instant a `try` block's `return` expression is *evaluated*, not once a returned promise *settles* - returning this chain unawaited let `nuke()` race the still-in-flight `decryptSecret` calls below and tear down the storage they read, and let this chain's rejections skip the `catch` beneath entirely (which is why failures here previously went unlogged).
		return await chunks.reduce<Promise<{ id: string; name: string }[]>>(async (acc, chunk) => [...(await acc), ...(await Promise.all(chunk.map(async ({ id, name }) => ({ id, name: await doStub.decryptSecret(apiKey, name) }))))], Promise.resolve([]));
	} catch (error) {
		console.error('Error fetching projects', error);
		// eslint-disable-next-line preserve-caught-error
		throw new Error(`Unable to fetch projects. Attempt ${bwId}`);
	} finally {
		this.platform.ctx.waitUntil(doStub.nuke('Session ended'));
	}
});
