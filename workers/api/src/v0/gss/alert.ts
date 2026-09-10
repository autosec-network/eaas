import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { drizzleD0 } from 'db/core';
import * as rootSchema from 'db/schemas/root';
import * as tenantSchema from 'db/schemas/tenant/main';
import { eq, inArray, sql } from 'drizzle-orm/sql';
import { hexToUuid } from 'helpers';
import { cloneRawRequest } from 'hono/request';
import { endTime, startTime, wrapTime } from 'hono/timing';
import { Buffer } from 'node:buffer';
import { createHash, createVerify, timingSafeEqual } from 'node:crypto';
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
	if (ak_id_buffer.byteLength !== 16 || !zm.validate(zm.uuidv7(), hexToUuid(ak_id_buffer.toString('hex')))) return false;

	const ak_secret_buffer = Buffer.from(ak_secret_base64url, 'base64url');
	// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
	return ak_secret_buffer.byteLength === expectedSecretBytesByVersion[parseInt(version) as ApiKeyVersions];
}

/**
 * Same per-version hashing `verifyToken` (`~/base`) does when validating a real request. GitHub's signature only proves the *pattern* matched something in a public repo - it says nothing about whether the secret is genuine, so a claimed leak still has to be checked against the tenant's stored hash before anything gets disabled.
 */
function hashSecret(version: ApiKeyVersions, secret: Buffer): Buffer {
	switch (version) {
		case ApiKeyVersions['256base64urlSha256']:
			return createHash('sha256').update(secret).digest();
		case ApiKeyVersions['384base64urlSha384']:
			return createHash('sha384').update(secret).digest();
		case ApiKeyVersions['512base64urlSha512']:
			return createHash('sha512').update(secret).digest();
	}
}

interface ParsedTokenBase {
	token: string;
	type: string;
}
type ParsedToken = ParsedTokenBase & ({ wellFormed: false } | { wellFormed: true; version: ApiKeyVersions; ak_id_hex: string; ak_secret_buffer: Buffer });

function parseToken(item: ParsedTokenBase): ParsedToken {
	if (!isWellFormedApiKey(item.token)) return { ...item, wellFormed: false };

	const [versionPart, ak_id_base64url, ak_secret_base64url] = item.token.split('.') as [`ase_${ApiKeyVersions}`, string, string];

	return {
		...item,
		wellFormed: true,
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
		version: parseInt(versionPart.slice('ase_'.length)) as ApiKeyVersions,
		ak_id_hex: Buffer.from(ak_id_base64url, 'base64url').toString('hex'),
		ak_secret_buffer: Buffer.from(ak_secret_base64url, 'base64url'),
	};
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

		const parsedTokens = body.map((item) => parseToken(item));

		// A well-formed token per ak_id - if more than one candidate shares an ak_id, any one matching the stored hash is enough to disable it.
		const candidatesByAkId = new Map<string, Extract<ParsedToken, { wellFormed: true }>[]>();
		for (const item of parsedTokens) {
			if (!item.wellFormed) continue;
			const list = candidatesByAkId.get(item.ak_id_hex);
			if (list) list.push(item);
			else candidatesByAkId.set(item.ak_id_hex, [item]);
		}

		// Only ak_id hexes whose presented secret actually hashed to the tenant's stored hash - the only ones we'll disable or report as `true_positive`.
		const verifiedAkIdHexes = new Set<string>();

		if (candidatesByAkId.size > 0) {
			startTime(c, 'r_db-find-leaked-keys');
			const candidateRootRows = await c.var.r_db
				.select({
					ak_id: rootSchema.api_keys_tenants.ak_id,
					do_id: rootSchema.tenants.do_id,
					jurisdiction: rootSchema.tenants.jurisdiction,
				})
				.from(rootSchema.api_keys_tenants)
				.innerJoin(rootSchema.tenants, eq(rootSchema.tenants.t_id, rootSchema.api_keys_tenants.t_id))
				.where(inArray(rootSchema.api_keys_tenants.ak_id, [...candidatesByAkId.keys()].map((hex) => sql`unhex(${hex})`) as unknown as [Buffer, ...Buffer[]]))
				.then((rows) =>
					rows.map((row) => ({
						ak_id_hex: row.ak_id.toString('hex'),
						do_id_hex: row.do_id.toString('hex'),
						jurisdiction: row.jurisdiction,
					})),
				);
			endTime(c, 'r_db-find-leaked-keys', 3);

			if (candidateRootRows.length > 0) {
				const tenantGroups = new Map<string, { jurisdiction: DOJurisdictions | null; ak_id_hexes: string[] }>();
				for (const row of candidateRootRows) {
					const group = tenantGroups.get(row.do_id_hex);
					if (group) group.ak_id_hexes.push(row.ak_id_hex);
					else tenantGroups.set(row.do_id_hex, { jurisdiction: row.jurisdiction, ak_id_hexes: [row.ak_id_hex] });
				}

				await wrapTime(
					c,
					'verify-and-disable-leaked-keys',
					Promise.all(
						Array.from(tenantGroups.entries()).map(async ([do_id_hex, { jurisdiction, ak_id_hexes }]) => {
							const doId = jurisdiction ? c.env.TENANT_D0.jurisdiction(jurisdiction).idFromString(do_id_hex) : c.env.TENANT_D0.idFromString(do_id_hex);
							// No cache — this path only ever reads once then writes. `throwOnError` lets a failed lookup/disable reach the global error handler instead of silently no-oping.
							const t_db = drizzleD0(c.env.TENANT_D0.get(doId), { throwOnError: true });

							const storedHashes = await t_db
								.select({ ak_id: tenantSchema.api_keys.ak_id, hash: tenantSchema.api_keys.hash })
								.from(tenantSchema.api_keys)
								.where(inArray(tenantSchema.api_keys.ak_id, ak_id_hexes.map((hex) => sql`unhex(${hex})`) as unknown as [Buffer, ...Buffer[]]));

							const tenantVerifiedAkIdHexes = storedHashes
								.filter(({ ak_id, hash }) => {
									const candidates = candidatesByAkId.get(ak_id.toString('hex')) ?? [];
									return candidates.some((candidate) => {
										const calculatedHash = hashSecret(candidate.version, candidate.ak_secret_buffer);
										// `timingSafeEqual` throws on a length mismatch rather than returning false - guard it first.
										return calculatedHash.byteLength === hash.byteLength && timingSafeEqual(calculatedHash, hash);
									});
								})
								.map(({ ak_id }) => ak_id.toString('hex'));

							if (tenantVerifiedAkIdHexes.length === 0) return;

							tenantVerifiedAkIdHexes.forEach((hex) => verifiedAkIdHexes.add(hex));

							return t_db
								.update(tenantSchema.api_keys)
								.set({ enabled: false })
								.where(inArray(tenantSchema.api_keys.ak_id, tenantVerifiedAkIdHexes.map((hex) => sql`unhex(${hex})`) as unknown as [Buffer, ...Buffer[]]));
						}),
					),
					undefined,
					3,
				);

				if (verifiedAkIdHexes.size > 0) {
					await wrapTime(
						c,
						'disable-leaked-keys-root',
						c.var.r_db
							.update(rootSchema.api_keys_tenants)
							.set({ enabled: false })
							.where(inArray(rootSchema.api_keys_tenants.ak_id, [...verifiedAkIdHexes].map((hex) => sql`unhex(${hex})`) as unknown as [Buffer, ...Buffer[]])),
						undefined,
						3,
					);
				}
			}
		}

		return c.json(
			parsedTokens.map(
				(item) =>
					({
						token_hash: createHash('sha256').update(item.token).digest('hex'),
						token_type: item.type,
						label: item.wellFormed && verifiedAkIdHexes.has(item.ak_id_hex) ? 'true_positive' : 'false_positive',
					}) satisfies z.output<typeof responseItemSchema>,
			) as [z.output<typeof responseItemSchema>, ...z.output<typeof responseItemSchema>[]],
			200,
		);
	},
);

export default app;
