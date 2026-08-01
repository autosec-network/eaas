import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { drizzleD0 } from 'db/core';
import * as rootSchema from 'db/schemas/root';
import * as tenantSchema from 'db/schemas/tenant/main';
import { eq, inArray, sql } from 'drizzle-orm/sql';
import { hexToUuid } from 'helpers';
import { cloneRawRequest } from 'hono/request';
import { endTime, startTime, wrapTime } from 'hono/timing';
import { Buffer } from 'node:buffer';
import { createHash, createVerify } from 'node:crypto';
import type { DOJurisdictions } from 'types';
import { ApiKeyVersions } from 'types/bw';
import * as zm from 'zod/mini';
import type { ContextVariables, EnvVars } from '~/types';
import { APITags } from '~/v0/extras';

const app = new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>();

/** Thrown when the request itself fails GitHub secret scanning signature verification */
class GithubSignatureError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'GithubSignatureError';
	}
}

/** Thrown when GitHub's public keys endpoint can't be reached or returns something unusable — not the caller's fault */
class GithubUpstreamError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'GithubUpstreamError';
	}
}

/**
 * Verify a GSS webhook payload and signature against GitHub's published public keys
 * @link https://docs.github.com/en/code-security/tutorials/secret-scanning-partner-program#create-a-secret-alert-service
 */
// @ts-expect-error - Hono middleware doesn't need to return when calling await next()
app.use('*', async (c, next) => {
	const keyID = c.req.header('Github-Public-Key-Identifier');
	const signature = c.req.header('Github-Public-Key-Signature');
	const payload = await cloneRawRequest(
		// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
		c.req,
	).then((req) => req.text());

	try {
		if (payload.length === 0) throw new GithubSignatureError('Missing request body');
		if (!signature) throw new GithubSignatureError('Missing Github-Public-Key-Signature header');
		if (!keyID) throw new GithubSignatureError('Missing Github-Public-Key-Identifier header');

		// Using manual cache because `cf.cacheEverything` keeps MISSING
		const cacheKey = new Request('https://api.github.com/meta/public_keys/secret_scanning', {
			headers: {
				'User-Agent': `Autosec EaaS/${c.env.GIT_HASH ?? '0.0'} (${['CloudflareWorkers', ...(c.req.raw.cf ? [`Colo=${(c.req.raw.cf as IncomingRequestCfPropertiesBase).colo}`] : []), `+${new URL(c.req.url).origin}`].join('; ')})`,
			},
		});
		// lib.dom's `CacheStorage` shadows the Workers-runtime one and doesn't declare `default`
		const cache = (globalThis.caches as unknown as { readonly default: Cache }).default;
		let response = await cache.match(cacheKey);

		if (!response) {
			response = await fetch(cacheKey);
			if (!response.ok) throw new GithubUpstreamError(`GitHub public keys endpoint returned ${response.status.toString()} ${response.statusText}`);

			c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
		}

		const keys = await response
			.json<{
				public_keys: {
					key_identifier: string;
					key: string;
					is_current: boolean;
				}[];
			}>()
			.catch((cause) => {
				throw new GithubUpstreamError('Failed to parse GitHub public keys response', { cause });
			});
		if (!Array.isArray(keys.public_keys) || keys.public_keys.length === 0) throw new GithubUpstreamError('No GitHub public keys found');
		const publicKey = keys.public_keys.find((k) => k.key_identifier === keyID);
		if (!publicKey) throw new GithubSignatureError('No public key found matching key identifier');

		const verify = createVerify('SHA256').update(payload);
		if (!verify.verify(publicKey.key, Buffer.from(signature, 'base64'))) throw new GithubSignatureError('Signature does not match payload');

		await next();
	} catch (error) {
		console.error(error);
		if (error instanceof GithubUpstreamError) return c.text(error.message, 502);
		return c.text(error instanceof Error ? error.message : 'Unauthorized', 401, {
			'WWW-Authenticate': 'GithubPublicKeySignature',
		});
	}
});

/**
 * Same shape `verifyToken` (`~/base`) parses, minus the DB lookup — whether `token` is a well-formed Autosec API key.
 * @link z.regexes.base64url
 */
const apiTokenFormat = /^ase_\d+\.[a-z\d_-]+\.[a-z\d_-]+$/i;

/** Per {@link ApiKeyVersions}, the exact secret length its scheme generates */
const expectedSecretBytesByVersion: Record<ApiKeyVersions, number> = {
	[ApiKeyVersions['256base64urlSha256']]: 256 / 8,
	[ApiKeyVersions['384base64urlSha384']]: 384 / 8,
	[ApiKeyVersions['512base64urlSha512']]: 512 / 8,
};

/**
 * Whether `token` matches Autosec's API key format: version known, key id decodes to a UUIDv7, secret is the exact length that version's scheme generates.
 * Doesn't check the database — a well-formed token that was never issued (or already revoked) still passes.
 */
function isWellFormedApiKey(token: string): boolean {
	if (!apiTokenFormat.test(token)) return false;

	const [versionPart, ak_id_base64url, ak_secret_base64url] = token.split('.') as [`ase_${ApiKeyVersions}`, string, string];
	const version = versionPart.slice('ase_'.length) as `${ApiKeyVersions}`;
	if (!(version in ApiKeyVersions)) return false;

	const ak_id_buffer = Buffer.from(ak_id_base64url, 'base64url');
	if (ak_id_buffer.byteLength !== 16 || !zm.uuidv7().safeParse(hexToUuid(ak_id_buffer.toString('hex'))).success) return false;

	const ak_secret_buffer = Buffer.from(ak_secret_base64url, 'base64url');
	// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
	return ak_secret_buffer.byteLength === expectedSecretBytesByVersion[parseInt(version) as ApiKeyVersions];
}

const responseItemSchema = z.object({
	token_hash: z.hash('sha256'),
	token_type: z.string().trim().nonempty(),
	label: z.enum(['true_positive', 'false_positive']),
});

/**
 * @link https://docs.github.com/en/code-security/tutorials/secret-scanning-partner-program#create-a-secret-alert-service
 */
app.openapi(
	createRoute({
		tags: [APITags.gss],
		method: 'post',
		path: '/',
		security: [{ GithubPublicKeyIdentifier: [], GithubPublicKeySignature: [] }],
		request: {
			body: {
				content: {
					'application/json': {
						schema: z
							.array(
								z.object({
									token: z.string().trim().nonempty(),
									type: z.string().trim().nonempty(),
									url: z
										.url({ protocol: /^https?$/, hostname: z.regexes.domain })
										.trim()
										.nonempty()
										.optional(),
									source: z.enum(['content', 'commit', 'pull_request_title', 'pull_request_description', 'pull_request_comment', 'issue_title', 'issue_description', 'issue_comment', 'discussion_title', 'discussion_body', 'discussion_comment', 'commit_comment', 'gist_content', 'gist_comment', 'wiki_content', 'wiki_commit', 'npm', 'manual_submission', 'unknown']),
								}),
							)
							.nonempty(),
					},
				},
				required: true,
			},
		},
		responses: {
			200: {
				content: {
					'application/json': {
						schema: z.array(responseItemSchema).nonempty(),
					},
				},
				description: '',
			},
		},
	}),
	async (c) => {
		const body = c.req.valid('json');

		const parsedTokens = body.map((item) => ({ ...item, wellFormed: isWellFormedApiKey(item.token) }));
		const leakedAkIdHexes = [...new Set(parsedTokens.filter((item) => item.wellFormed).map((item) => Buffer.from(item.token.split('.')[1]!, 'base64url').toString('hex')))];

		if (leakedAkIdHexes.length > 0) {
			startTime(c, 'r_db-find-leaked-keys');
			const leakedKeys = await c.var.r_db
				.select({
					ak_id: rootSchema.api_keys_tenants.ak_id,
					do_id: rootSchema.tenants.do_id,
					jurisdiction: rootSchema.tenants.jurisdiction,
				})
				.from(rootSchema.api_keys_tenants)
				.innerJoin(rootSchema.tenants, eq(rootSchema.tenants.t_id, rootSchema.api_keys_tenants.t_id))
				.where(inArray(rootSchema.api_keys_tenants.ak_id, leakedAkIdHexes.map((hex) => sql`unhex(${hex})`) as unknown as [Buffer, ...Buffer[]]))
				.then((rows) =>
					rows.map((row) => ({
						ak_id_hex: row.ak_id.toString('hex'),
						do_id_hex: row.do_id.toString('hex'),
						jurisdiction: row.jurisdiction,
					})),
				);
			endTime(c, 'r_db-find-leaked-keys', 3);

			if (leakedKeys.length > 0) {
				const rootUpdates = leakedKeys.map((row) =>
					c.var.r_db
						.update(rootSchema.api_keys_tenants)
						.set({ enabled: false })
						.where(eq(rootSchema.api_keys_tenants.ak_id, sql<Buffer>`unhex(${row.ak_id_hex})`)),
				);

				const tenantGroups = new Map<string, { jurisdiction: DOJurisdictions | null; ak_id_hexes: string[] }>();
				for (const row of leakedKeys) {
					const group = tenantGroups.get(row.do_id_hex);
					if (group) group.ak_id_hexes.push(row.ak_id_hex);
					else tenantGroups.set(row.do_id_hex, { jurisdiction: row.jurisdiction, ak_id_hexes: [row.ak_id_hex] });
				}

				const tenantUpdates = Array.from(tenantGroups.entries()).map(([do_id_hex, { jurisdiction, ak_id_hexes }]) => {
					const doId = jurisdiction ? c.env.TENANT_D0.jurisdiction(jurisdiction).idFromString(do_id_hex) : c.env.TENANT_D0.idFromString(do_id_hex);
					// No cache — this path only ever writes. `throwOnError` lets a failed disable reach the global error handler instead of silently no-oping.
					const t_db = drizzleD0(c.env.TENANT_D0.get(doId), { throwOnError: true });

					return t_db
						.update(tenantSchema.api_keys)
						.set({ enabled: false })
						.where(inArray(tenantSchema.api_keys.ak_id, ak_id_hexes.map((hex) => sql`unhex(${hex})`) as unknown as [Buffer, ...Buffer[]]));
				});

				await wrapTime(c, 'disable-leaked-keys', Promise.all([c.var.r_db.batch(rootUpdates as [(typeof rootUpdates)[number], ...(typeof rootUpdates)[number][]]), ...tenantUpdates]), undefined, 3);
			}
		}

		return c.json(
			parsedTokens.map(
				({ token, type, wellFormed }) =>
					({
						token_hash: createHash('sha256').update(token).digest('hex'),
						token_type: type,
						label: wellFormed ? 'true_positive' : 'false_positive',
					}) satisfies z.output<typeof responseItemSchema>,
			) as [z.output<typeof responseItemSchema>, ...z.output<typeof responseItemSchema>[]],
			200,
		);
	},
);

export default app;
