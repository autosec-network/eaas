import { routeLoader$, type RequestHandler } from '@builder.io/qwik-city';
import * as jose from 'jose';
import { createHash } from 'node:crypto';
import type { Session } from '~/types';

/**
 * `routeLoader$` runs after `onRequest` but is preferred to take advantage of caching.
 * `plugin@` files are loaded before any other files (layout, index, etc) so it will still run before other middleware or handlers.
 */

export const onRequest: RequestHandler = async ({ request, platform, next, error }) => {
	if ('GIT_HASH' in platform.env) {
		if ((platform.request ?? request).headers.has('Cf-Access-Jwt-Assertion')) {
			await next();
		} else {
			throw error(401, 'Unauthorized');
		}
	} else {
		await next();
	}
};

/**
 * The Access team's JWKS, used to verify the signature on `Cf-Access-Jwt-Assertion`.
 *
 * Unlike the identity endpoint below, these certs are the same for every user, so the cache key is just the URL - no per-user hashing needed.
 */
// eslint-disable-next-line qwik/loader-location
const usePublicCerts = routeLoader$(async ({ platform, request, error }) => {
	const cacheKey = new Request(new URL(['cdn-cgi', 'access', 'certs'].join('/'), platform.env.ZT_TEAM_DOMAIN), {
		signal: request.signal,
	});
	const cache = platform.caches?.default ?? globalThis.caches.default;

	let response = await cache.match(cacheKey);

	if (!response) {
		// If not in cache, get it from origin
		response = await fetch(cacheKey);

		// Must use Response constructor to inherit all of response's fields
		response = new Response(response.body, response);

		platform.ctx.waitUntil(cache.put(cacheKey, response.clone()));
	}

	if (response.ok) {
		return response.json<jose.JSONWebKeySet>();
	} else {
		console.error('Failed to fetch public certs', `HTTP ${response.status}: ${response.statusText}`);
		throw error(502, 'Authentication service unavailable');
	}
});

/**
 * The full identity Access has on the current user (groups, idp, device posture, etc) - everything the JWT itself doesn't carry.
 *
 * Unlike the certs, this endpoint answers per-user, so the cache entry has to be per-user too. The key gets a hash of the JWT instead of the JWT itself, so no token material ends up in a cache key, and a re-issued JWT simply misses instead of reading someone else's identity.
 */
// eslint-disable-next-line qwik/loader-location
const useIdentity = routeLoader$(async ({ platform, request }) => {
	const jwt = (platform.request ?? request).headers.get('Cf-Access-Jwt-Assertion')!;

	const identityUrl = new URL(['cdn-cgi', 'access', 'get-identity'].join('/'), platform.env.ZT_TEAM_DOMAIN);
	const cacheUrl = new URL(identityUrl);
	cacheUrl.searchParams.set('jwt', createHash('sha512').update(jwt).digest('base64url'));
	const cacheKey = new Request(cacheUrl, { signal: request.signal });
	const cache = platform.caches?.default ?? globalThis.caches.default;

	let response = await cache.match(cacheKey);

	if (!response) {
		// If not in cache, get it from origin. `manual` keeps the login redirect of a token Access doesn't like from being followed into an html page
		response = await fetch(identityUrl, {
			headers: { cookie: `CF_Authorization=${jwt}` },
			redirect: 'manual',
			signal: request.signal,
		});

		if (response.ok) {
			// `tee()` is cheaper than `clone()`
			const [returnBody, cacheBody] = response.body!.tee();
			response = new Response(returnBody, response);

			platform.ctx.waitUntil(
				(async () => {
					let cacheResponse = new Response(cacheBody, response);

					// 15 minutes * 60 seconds
					const fallbackCacheAge = 900 as const;
					if (!cacheResponse.headers.has('Cache-Control')) cacheResponse.headers.set('Cache-Control', [`s-maxage=${fallbackCacheAge}`, `max-age=${fallbackCacheAge}`].join(', '));
					if (!cacheResponse.headers.has('ETag')) {
						// I need a fresh body again
						const [_cacheBody, etagBody] = cacheBody.tee();
						cacheResponse = new Response(_cacheBody, cacheResponse);

						async function* streamAsyncIterable(stream: ReadableStream<Uint8Array>) {
							const reader = stream.getReader();
							try {
								while (true) {
									const { done, value } = await reader.read();
									if (done) return;
									yield value;
								}
							} finally {
								reader.releaseLock();
							}
						}

						const hash = createHash('sha512');
						for await (const chunk of streamAsyncIterable(etagBody)) {
							hash.update(chunk);
						}
						cacheResponse.headers.set('ETag', `"${hash.digest('hex')}"`);
					}

					return cache.put(cacheKey, cacheResponse);
				})(),
			);
		}
	}

	if (response.ok) {
		return response.json<CloudflareAccessIdentity>();
	} else {
		console.error({
			cf: response.cf as object | undefined,
			headers: Object.fromEntries(response.headers.entries()),
			redirected: response.redirected,
			status: response.status,
			statusText: response.statusText,
			text: await response.text(),
			url: identityUrl.toString(),
		});
		return {};
	}
});

export const useJwtValidate = routeLoader$(async ({ platform, request, error, resolveValue, sharedMap }) => {
	if ('GIT_HASH' in platform.env) {
		if ((platform.request ?? request).headers.has('Cf-Access-Jwt-Assertion')) {
			const JWKS = jose.createLocalJWKSet(await resolveValue(usePublicCerts));

			await Promise.all([
				jose.jwtVerify(request.headers.get('Cf-Access-Jwt-Assertion')!, JWKS, {
					issuer: platform.env.ZT_TEAM_DOMAIN,
					audience: platform.env.ZT_APP_AUD,
				}),
				resolveValue(useIdentity),
			])
				// eslint-disable-next-line @typescript-eslint/no-unused-vars
				.then(([{ payload }, { user_uuid, email, device_sessions, ...user }]) =>
					sharedMap.set('session', {
						user: {
							id: payload.sub ?? user_uuid,
							email: payload['email'] ?? email,
							...user,
						},
						expires: (payload.exp ? new Date(payload.exp * 1000) : new Date()).toISOString(),
					} satisfies Session),
				)
				.catch((e) => {
					console.error('JWT Verification Error:', e);
					throw error(403, 'Forbidden');
				});
		} else {
			throw error(401, 'Unauthorized');
		}
	}
});

export const useSession = routeLoader$(async ({ resolveValue, sharedMap }) => {
	// Make sure auth actually completes
	await resolveValue(useJwtValidate);

	return sharedMap.get('session') as Session | undefined;
});
