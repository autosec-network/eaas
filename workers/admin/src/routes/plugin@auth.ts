import { routeLoader$, type RequestHandler } from '@builder.io/qwik-city';
import * as jose from 'jose';

/**
 * `routeLoader$` runs after `onRequest` but is preferred to take advantage of caching.
 * `plugin@` files are loaded before any other files (layout, index, etc) so it will still run before other middleware or handlers.
 */

export const onRequest: RequestHandler = async ({ request, platform, next, error }) => {
	if ('GIT_HASH' in platform.env) {
		if (request.headers.has('Cf-Access-Jwt-Assertion')) {
			await next();
		} else {
			throw error(401, 'Unauthorized');
		}
	} else {
		await next();
	}
};

export const usePublicCerts = routeLoader$(async ({ platform, request, error }) => {
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

export const useJwtValidate = routeLoader$(async ({ platform, request, error, resolveValue, sharedMap }) => {
	if ('GIT_HASH' in platform.env) {
		if (request.headers.has('Cf-Access-Jwt-Assertion')) {
			const JWKS = jose.createLocalJWKSet(await resolveValue(usePublicCerts));

			await jose
				.jwtVerify(request.headers.get('Cf-Access-Jwt-Assertion')!, JWKS, {
					issuer: platform.env.ZT_TEAM_DOMAIN,
					audience: platform.env.ZT_APP_AUD,
				})
				.then(({ payload }) => sharedMap.set('user', payload))
				.catch((e) => {
					console.error('JWT Verification Error:', e);
					throw error(403, 'Forbidden');
				});
		} else {
			throw error(401, 'Unauthorized');
		}
	}
});
