/**
 * Custom adapter for D1/DO API, attempting to keep same usability as `@auth/d1-adapter`
 * @link https://github.com/nextauthjs/next-auth/tree/main/packages/adapter-d1
 */
import type { Adapter } from '@auth/core/adapters';
import { drizzleD0 } from 'db/core';
import * as rootSchema from 'db/schemas/root';
import * as userSchema from 'db/schemas/user';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { eq, sql } from 'drizzle-orm/sql';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import { SQLCache } from 'helpers/db';
import { createHash, type UUID } from 'node:crypto';
import type { DOJurisdictions } from 'types';
import * as zm from 'zod/mini';
import { emailCanonicalize } from '~/routes/plugin@auth';
import type { UserD0 } from '~/types';

function hexToUuid(hex: string): UUID {
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * @link https://docs.gravatar.com/sdk/images/
 */
function emailToGravatar(email: string, defaulta: 'color' | 'mp' | 'identicon' | 'monsterid' | 'wavatar' | 'retro' | 'robohash' | 'blank' = 'robohash') {
	const emailHash = createHash('sha256').update(email).digest('hex');
	const gravatarImage = new URL(['avatar', emailHash].join('/'), 'https://gravatar.com');
	gravatarImage.searchParams.set('d', defaulta);
	return gravatarImage.href;
}

export function D0Adapter(platform: QwikCityPlatform, r_db: DrizzleD1Database<typeof rootSchema>, toCache: boolean): Adapter {
	function getUserD0(jurisdiction: DOJurisdictions | null, u_id_utf8: UUID): DurableObjectStub<UserD0>;
	function getUserD0(jurisdiction: DOJurisdictions | null, do_id_hex: string): DurableObjectStub<UserD0>;
	// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
	function getUserD0(jurisdiction: DOJurisdictions | null, do_id_hexOrUid: UUID | string) {
		const doNamespace = jurisdiction ? platform.env.USER_D0.jurisdiction(jurisdiction) : platform.env.USER_D0;
		const doId = zm
			.union([
				zm.pipe(
					zm.uuidv7(),
					zm.transform((u_id_utf8) => {
						const id = doNamespace.idFromName(u_id_utf8);

						platform.ctx.waitUntil(
							r_db
								.update(rootSchema.users)
								.set({
									do_id: sql`unhex(${id.toString()})`,
								})
								.where(eq(rootSchema.users.u_id, sql`unhex(${u_id_utf8.replaceAll('-', '')})`)),
						);

						return id;
					}),
				),
				zm.pipe(
					zm.hex().check(zm.length(64)),
					zm.transform((do_id_hex) => doNamespace.idFromString(do_id_hex)),
				),
			])
			.parse(do_id_hexOrUid);

		return platform.env.USER_D0.get(doId);
	}

	function getUserDb(jurisdiction: DOJurisdictions | null, u_id_utf8: UUID): SqliteRemoteDatabase<typeof userSchema>;
	function getUserDb(jurisdiction: DOJurisdictions | null, do_id_hex: string): SqliteRemoteDatabase<typeof userSchema>;
	// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
	function getUserDb(jurisdiction: DOJurisdictions | null, do_id_hexOrUid: UUID | string) {
		const doNamespace = jurisdiction ? platform.env.USER_D0.jurisdiction(jurisdiction) : platform.env.USER_D0;
		const doId = zm
			.union([
				zm.pipe(
					zm.uuidv7(),
					zm.transform((u_id_utf8) => {
						const id = doNamespace.idFromName(u_id_utf8);

						platform.ctx.waitUntil(
							r_db
								.update(rootSchema.users)
								.set({
									do_id: sql`unhex(${id.toString()})`,
								})
								.where(eq(rootSchema.users.u_id, sql`unhex(${u_id_utf8.replaceAll('-', '')})`)),
						);

						return id;
					}),
				),
				zm.pipe(
					zm.hex().check(zm.length(64)),
					zm.transform((do_id_hex) => doNamespace.idFromString(do_id_hex)),
				),
			])
			.parse(do_id_hexOrUid);
		const doStub = platform.env.USER_D0.get(doId);

		return drizzleD0(doStub, {
			schema: userSchema,
			casing: 'snake_case',
			cache: toCache
				? new SQLCache(
						{
							dbName: doId.toString(),
							dbType: 'do',
							strategy: 'all',
							cacheTTL: parseInt(platform.env.SQL_TTL, 10),
						},
						platform.caches ?? globalThis.caches,
					)
				: undefined,
		});
	}

	return {
		// Users
		// @ts-expect-error @todo @demosjarco
		createUser: (user) => {},
		// @ts-expect-error @todo @demosjarco
		getUser: (id) => {},
		// updateUser: (user) => {},
		// Oauth
		// getUserByAccount: ({ provider, providerAccountId }) => {},
		// @ts-expect-error @todo @demosjarco
		getAccount: (providerAccountId, provider) => {},
		// @ts-expect-error @todo @demosjarco
		linkAccount: (account) => {},
		// Sessions
		// @ts-expect-error @todo @demosjarco
		createSession: (session) => {},
		// @ts-expect-error @todo @demosjarco
		getSessionAndUser: (sessionToken) => {},
		// @ts-expect-error @todo @demosjarco
		updateSession: ({ sessionToken, userId, expires, ...session }) => {},
		// @ts-expect-error @todo @demosjarco
		deleteSession: (sessionToken) => {},
		// Email magic links
		getUserByEmail: async (email) => {
			const [selectedUser] = await r_db
				.select({
					u_id: rootSchema.users.u_id,
					jurisdiction: rootSchema.users.jurisdiction,
					do_id: rootSchema.users.do_id,
				})
				.from(rootSchema.users)
				.where(eq(rootSchema.users.email_key, sql`unhex(${(await emailCanonicalize(platform, email)).digest('hex')})`))
				.limit(1);

			if (selectedUser) {
				const u_id_hex = selectedUser.u_id.toString('hex');
				const u_id_uft8 = hexToUuid(u_id_hex);
				const do_id_hex = selectedUser.do_id?.toString('hex');

				const initialUser = {
					id: u_id_uft8,
					u_id: {
						hex: u_id_hex,
						base64: selectedUser.u_id.toString('base64'),
						base64url: selectedUser.u_id.toString('base64url'),
					},
					do_jurisdiction: selectedUser.jurisdiction,
					do_id: do_id_hex,
					email,
					image: emailToGravatar(email),
				};

				const doStub = getUserD0(selectedUser.jurisdiction, do_id_hex ?? u_id_uft8);

				/**
				 * @todo @demosjarco get from properties
				 */
				return {
					...initialUser,
					emailVerified: null,
				} satisfies Exclude<Awaited<ReturnType<Exclude<Adapter['getUserByAccount'], undefined>>>, null>;
			} else {
				return null;
			}
		},
		createVerificationToken: async (verificationToken) => {
			const [selectedUser] = await r_db
				.select({
					u_id: rootSchema.users.u_id,
					jurisdiction: rootSchema.users.jurisdiction,
					do_id: rootSchema.users.do_id,
				})
				.from(rootSchema.users)
				.where(eq(rootSchema.users.email_key, sql`unhex(${(await emailCanonicalize(platform, verificationToken.identifier)).digest('hex')})`))
				.limit(1);

			if (selectedUser) {
				const u_db = getUserDb(selectedUser.jurisdiction, selectedUser.do_id?.toString('hex') ?? hexToUuid(selectedUser.u_id.toString('hex')));

				await u_db.insert(userSchema.auth_verification_token).values({
					hashed_token: sql`unhex(${verificationToken.token})`,
					expires_timestamp: verificationToken.expires.toISOString(),
				});

				return verificationToken satisfies Exclude<Awaited<ReturnType<Exclude<Adapter['createVerificationToken'], undefined>>>, null>;
			}

			return null;
		},
		useVerificationToken: async ({ identifier, token }) => {
			const [selectedUser] = await r_db
				.select({
					u_id: rootSchema.users.u_id,
					jurisdiction: rootSchema.users.jurisdiction,
					do_id: rootSchema.users.do_id,
				})
				.from(rootSchema.users)
				.where(eq(rootSchema.users.email_key, sql`unhex(${(await emailCanonicalize(platform, identifier)).digest('hex')})`))
				.limit(1);

			if (selectedUser) {
				const u_db = getUserDb(selectedUser.jurisdiction, selectedUser.do_id?.toString('hex') ?? hexToUuid(selectedUser.u_id.toString('hex')));

				/**
				 * Because we're storing as BLOB BINARY, we already do a byte-for-byte comparison
				 * Also because this transverses RPC/Bindings, network noise already adds jitter (so no need for `timingSafeEqual()`)
				 */
				const [selectedToken] = await u_db
					.select({
						expires_timestamp: userSchema.auth_verification_token.expires_timestamp,
					})
					.from(userSchema.auth_verification_token)
					.where(eq(userSchema.auth_verification_token.hashed_token, sql`unhex(${token})`));

				if (selectedToken) {
					// Prevent re-use
					await u_db.delete(userSchema.auth_verification_token).where(eq(userSchema.auth_verification_token.hashed_token, sql`unhex(${token})`));

					return {
						identifier,
						token,
						expires: new Date(selectedToken.expires_timestamp),
					} satisfies Exclude<Awaited<ReturnType<Exclude<Adapter['useVerificationToken'], undefined>>>, null>;
				}
			}

			return null;
		},
		// Passkeys
		// @ts-expect-error @todo @demosjarco
		getAuthenticator: (credentialID) => {},
		// @ts-expect-error @todo @demosjarco
		createAuthenticator: () => {},
		// @ts-expect-error @todo @demosjarco
		listAuthenticatorsByUserId: (userId) => {},
		// @ts-expect-error @todo @demosjarco
		updateAuthenticatorCounter: (credentialID, newCounter) => {},
	};
}
