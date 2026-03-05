/**
 * Custom adapter for D1/DO API, attempting to keep same usability as `@auth/d1-adapter`
 * @link https://github.com/nextauthjs/next-auth/tree/main/packages/adapter-d1
 */
import type { Adapter } from '@auth/core/adapters';
import { drizzleD0 } from 'db/core';
import * as rootSchema from 'db/schemas/root';
import * as userSchema from 'db/schemas/user';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { and, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm/sql';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import { hexToUuid } from 'helpers';
import { SQLCache } from 'helpers/db';
import { createHash, type UUID } from 'node:crypto';
import { DOJurisdictions } from 'types';
import * as zm from 'zod/mini';
import { emailCanonicalize, getSessionBinding, getUserD0 } from '~/routes/plugin@auth';

/**
 * @link https://docs.gravatar.com/sdk/images/
 */
function emailToGravatar(email: string, defaultIcon: 'color' | 'mp' | 'identicon' | 'monsterid' | 'wavatar' | 'retro' | 'robohash' | 'blank' = 'robohash') {
	const emailHash = createHash('sha256').update(email).digest('hex');
	const gravatarImage = new URL(['avatar', emailHash].join('/'), 'https://gravatar.com');
	gravatarImage.searchParams.set('d', defaultIcon);
	return gravatarImage.href;
}

export function D0Adapter(platform: QwikCityPlatform, request: Request, r_db: DrizzleD1Database<typeof rootSchema>, toCache: boolean): Adapter {
	const platformAuthSecretHash_hex = createHash('sha256').update(Buffer.from(platform.env.AUTH_SECRET, 'base64').toString('hex')).digest('hex');

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
						// Are they really not in the EU?
						const currentlyEu = ((platform.request ?? platform).cf as IncomingRequestCfProperties).isEUCountry === '1';

						// Last chance for us to change jurisdiction, can't change after db is instantiated
						const id = (jurisdiction === null && currentlyEu ? doNamespace.jurisdiction('eu') : doNamespace).idFromName(u_id_utf8);

						platform.ctx.waitUntil(
							r_db
								.update(rootSchema.users)
								.set({
									jurisdiction: (jurisdiction ?? currentlyEu) ? DOJurisdictions['The European Union'] : null,
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
		// Unknown
		// @ts-expect-error @todo @demosjarco
		deleteUser: (userId) => {
			console.debug('deleteUser', userId);
		},
		// @ts-expect-error @todo @demosjarco
		getUserByAccount: (providerAccountId) => {
			console.debug('getUserByAccount', providerAccountId);
		},
		// @ts-expect-error @todo @demosjarco
		unlinkAccount: (providerAccountId) => {
			console.debug('unlinkAccount', providerAccountId);
		},
		// Users
		// @ts-expect-error @todo @demosjarco
		createUser: (user) => {
			console.debug('createUser', user);
		},
		// @ts-expect-error @todo @demosjarco
		getUser: (id) => {
			console.debug('getUser', id);
		},
		updateUser: async ({ id: u_id_utf8, ...user }) => {
			const [selectedUser] = await r_db
				.select({
					jurisdiction: rootSchema.users.jurisdiction,
					do_id: rootSchema.users.do_id,
				})
				.from(rootSchema.users)
				.where(eq(rootSchema.users.u_id, sql`unhex(${u_id_utf8.replaceAll('-', '')})`))
				.limit(1);

			if (selectedUser) {
				const do_id_hex = selectedUser.do_id?.toString('hex');
				const doStub = getUserD0(platform, r_db, selectedUser.jurisdiction, do_id_hex ?? u_id_utf8);

				if ('email' in user || 'emailVerified' in user) {
					const storagePromises: Promise<any>[] = [];

					if ('email' in user && user.email) {
						storagePromises.push(
							r_db
								.update(rootSchema.users)
								.set({
									email_key: sql`unhex(${(await emailCanonicalize(platform, user.email)).digest('hex')})`,
								})
								.where(eq(rootSchema.users.u_id, sql`unhex(${u_id_utf8.replaceAll('-', '')})`))
								.limit(1),
						);
					}

					if ('emailVerified' in user && user.emailVerified) {
						storagePromises.push(
							r_db
								.update(rootSchema.users)
								.set({
									user_init: true,
								})
								.where(eq(rootSchema.users.u_id, sql`unhex(${u_id_utf8.replaceAll('-', '')})`))
								.limit(1),
						);
					}

					storagePromises.push(
						doStub.updateProperties(
							{
								...('email' in user && user.email && { email: user.email }),
								...('emailVerified' in user && user.emailVerified && { email_verified: user.emailVerified }),
								m_time: new Date(),
							},
							false,
							true,
						),
					);

					// Make sure the other finish writing before moving on, to prevent race conditions
					await Promise.allSettled(storagePromises).then((settled) => {
						// eslint-disable-next-line @typescript-eslint/no-unsafe-return
						const errors = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason);

						if (errors.length > 0) throw new AggregateError(errors, 'Failed to update one or more user durable objects/sessions');
					});
				}

				const u_id_hex = u_id_utf8.replaceAll('-', '');
				const u_id = Buffer.from(u_id_hex, 'hex');
				const email = user.email ?? (await doStub.getProperties({ email: true }, true)).email!;

				return {
					id: u_id_utf8,
					u_id: {
						hex: u_id_hex,
						base64: u_id.toString('base64'),
						base64url: u_id.toString('base64url'),
					},
					do_jurisdiction: selectedUser.jurisdiction,
					do_id: do_id_hex,
					email,
					emailVerified: user.emailVerified ?? (await doStub.getProperties({ email_verified: true }, true)).email_verified ?? null,
					image: emailToGravatar(email),
				} satisfies Awaited<ReturnType<Exclude<Adapter['updateUser'], undefined>>>;
			} else {
				throw new Error('User not found');
			}
		},
		// Oauth
		// @ts-expect-error @todo @demosjarco
		getAccount: (providerAccountId, provider) => {
			console.debug('getAccount', providerAccountId, provider);
		},
		// @ts-expect-error @todo @demosjarco
		linkAccount: (account) => {
			console.debug('linkAccount', account);
		},
		// Sessions
		createSession: async (session) => {
			const b_time = new Date(session.expires.getTime() - parseInt(platform.env.SESSION_TTL, 10) * 1000);

			const [selectedUser] = await r_db
				.select({
					jurisdiction: rootSchema.users.jurisdiction,
				})
				.from(rootSchema.users)
				.where(eq(rootSchema.users.u_id, sql`unhex(${session.userId.replaceAll('-', '')})`))
				.limit(1);
			const doId = selectedUser?.jurisdiction
				? // Regenerate new one since the previous one has no jurisdiction
					platform.env.USER_SESSION.jurisdiction(selectedUser.jurisdiction).newUniqueId()
				: platform.env.USER_SESSION.idFromString(session.sessionToken);

			const [{ lite, normal, sensitive }] = await Promise.all([
				getSessionBinding((platform.request ?? platform).cf as IncomingRequestCfProperties, (platform.request ?? request).headers),
				r_db.insert(rootSchema.users_auth_sessions).values({
					u_id: sql`unhex(${session.userId.replaceAll('-', '')})`,
					session_token: sql`unhex(${doId.toString()})`,
					expires: session.expires.toISOString(),
				}),
			]);

			const doStub = platform.env.USER_SESSION.get(doId);
			await doStub.updateProperties(
				{
					b_time,
					lite_binding: lite,
					normal_binding: normal,
					sensitive_binding: sensitive,
				},
				false,
				true,
			);

			return {
				...session,
				b_time,
				do_jurisdiction: selectedUser?.jurisdiction ?? null,
				do_id: doId.toString(),
				lite_binding: lite,
				normal_binding: normal,
				sensitive_binding: sensitive,
			} satisfies Awaited<ReturnType<Exclude<Adapter['createSession'], undefined>>>;
		},
		getSessionAndUser: async (sessionToken) => {
			const [selectedUserSession] = await r_db
				.select({
					u_id: rootSchema.users.u_id,
					jurisdiction: rootSchema.users.jurisdiction,
					do_id: rootSchema.users.do_id,
					expires: rootSchema.users_auth_sessions.expires,
				})
				.from(rootSchema.users)
				.innerJoin(rootSchema.users_auth_sessions, eq(rootSchema.users.u_id, rootSchema.users_auth_sessions.u_id))
				.where(eq(rootSchema.users_auth_sessions.session_token, sql`unhex(${sessionToken})`))
				.limit(1)
				.then((rows) =>
					rows.map((row) => ({
						...row,
						do_id: row.do_id?.toString('hex') ?? null,
						expires: new Date(row.expires),
					})),
				);

			if (selectedUserSession) {
				const u_id_hex = selectedUserSession.u_id.toString('hex');
				const u_id_utf8 = hexToUuid(u_id_hex);

				const [session, user] = await Promise.all([
					(async () => {
						const doId = selectedUserSession.jurisdiction ? platform.env.USER_SESSION.jurisdiction(selectedUserSession.jurisdiction).idFromString(sessionToken) : platform.env.USER_SESSION.idFromString(sessionToken);
						const doStub = platform.env.USER_SESSION.get(doId);

						const { b_time, lite_binding, normal_binding, sensitive_binding, generated_registration_options } = await doStub.getProperties(undefined, true);

						return {
							b_time: b_time!,
							expires: selectedUserSession.expires,
							lite_binding: lite_binding!,
							normal_binding: normal_binding!,
							sensitive_binding: sensitive_binding!,
							sessionToken,
							userId: u_id_utf8,
							do_id: sessionToken,
							do_jurisdiction: selectedUserSession.jurisdiction,
							// @ts-expect-error Type instanciation too deep
							generated_registration_options: generated_registration_options!,
						} satisfies Exclude<Awaited<ReturnType<Exclude<Adapter['getSessionAndUser'], undefined>>>, null>['session'];
					})(),
					(async () => {
						const doStub = getUserD0(platform, r_db, selectedUserSession.jurisdiction, selectedUserSession.do_id ?? u_id_utf8);

						const { email, email_verified } = await doStub.getProperties({ email: true, email_verified: true }, true);

						return {
							email: email!,
							emailVerified: email_verified!,
							id: u_id_utf8,
							do_jurisdiction: selectedUserSession.jurisdiction,
							do_id: selectedUserSession.do_id ?? undefined,
							image: email ? emailToGravatar(email) : undefined,
							u_id: {
								hex: u_id_hex,
								base64: selectedUserSession.u_id.toString('base64'),
								base64url: selectedUserSession.u_id.toString('base64url'),
							},
						} satisfies Exclude<Awaited<ReturnType<Exclude<Adapter['getSessionAndUser'], undefined>>>, null>['user'];
					})(),
				]);

				return { session, user } satisfies Exclude<Awaited<ReturnType<Exclude<Adapter['getSessionAndUser'], undefined>>>, null>;
			} else {
				return null;
			}
		},
		updateSession: async ({ sessionToken, ...session }) => {
			console.debug('updateSession', { sessionToken, ...session });

			const [selectedSession] = await r_db
				.select({
					u_id: rootSchema.users.u_id,
					jurisdiction: rootSchema.users.jurisdiction,
					do_id: rootSchema.users.do_id,
					expires: rootSchema.users_auth_sessions.expires,
				})
				.from(rootSchema.users)
				.innerJoin(rootSchema.users_auth_sessions, eq(rootSchema.users.u_id, rootSchema.users_auth_sessions.u_id))
				.where(eq(rootSchema.users_auth_sessions.session_token, sql`unhex(${sessionToken})`))
				.limit(1)
				.then((rows) =>
					rows.map((row) => ({
						...row,
						u_id: row.u_id.toString('hex'),
						do_id: row.do_id?.toString('hex') ?? null,
						expires: new Date(row.expires),
					})),
				);

			if (selectedSession) {
				const doId = selectedSession.jurisdiction ? platform.env.USER_SESSION.jurisdiction(selectedSession.jurisdiction).idFromString(sessionToken) : platform.env.USER_SESSION.idFromString(sessionToken);
				const doStub = platform.env.USER_SESSION.get(doId);

				if ('b_time' in session || 'lite_binding' in session || 'normal_binding' in session || 'sensitive_binding' in session) {
					await doStub.updateProperties(
						{
							...('b_time' in session && { b_time: session.b_time }),
							...('lite_binding' in session && { lite_binding: session.lite_binding }),
							...('normal_binding' in session && { normal_binding: session.normal_binding }),
							...('sensitive_binding' in session && { sensitive_binding: session.sensitive_binding }),
							...('generated_registration_options' in session && { generated_registration_options: session.generated_registration_options }),
						},
						false,
						true,
					);
				}

				const { b_time, lite_binding, normal_binding, sensitive_binding, generated_registration_options } = await doStub.getProperties(
					{
						...(!('b_time' in session) && { b_time: true }),
						...(!('lite_binding' in session) && { lite_binding: true }),
						...(!('normal_binding' in session) && { normal_binding: true }),
						...(!('sensitive_binding' in session) && { sensitive_binding: true }),
						...(!('generated_registration_options' in session) && { generated_registration_options: true }),
					},
					true,
				);

				if (!(session.lite_binding ?? lite_binding) || !(session.normal_binding ?? normal_binding) || !(session.sensitive_binding ?? sensitive_binding)) {
					return null;
				}

				return {
					b_time: session.b_time ?? b_time ?? new Date(selectedSession.expires.getTime() - parseInt(platform.env.SESSION_TTL, 10) * 1000),
					expires: selectedSession.expires,
					lite_binding: session.lite_binding ?? lite_binding!,
					normal_binding: session.normal_binding ?? normal_binding!,
					sensitive_binding: session.sensitive_binding ?? sensitive_binding!,
					sessionToken,
					userId: hexToUuid(selectedSession.u_id),
					do_id: sessionToken,
					do_jurisdiction: selectedSession.jurisdiction,
					generated_registration_options: session.generated_registration_options ?? generated_registration_options,
				} satisfies Exclude<Awaited<ReturnType<Exclude<Adapter['updateSession'], undefined>>>, null>;
			} else {
				return null;
			}
		},
		deleteSession: async (sessionToken) => {
			console.debug('deleteSession', sessionToken);

			const [selectedSession] = await r_db
				.select({
					u_id: rootSchema.users.u_id,
					jurisdiction: rootSchema.users.jurisdiction,
					do_id: rootSchema.users.do_id,
					expires: rootSchema.users_auth_sessions.expires,
				})
				.from(rootSchema.users)
				.innerJoin(rootSchema.users_auth_sessions, eq(rootSchema.users.u_id, rootSchema.users_auth_sessions.u_id))
				.where(eq(rootSchema.users_auth_sessions.session_token, sql`unhex(${sessionToken})`))
				.limit(1)
				.then((rows) =>
					rows.map((row) => ({
						...row,
						u_id: row.u_id.toString('hex'),
						do_id: row.do_id?.toString('hex') ?? null,
						expires: new Date(row.expires),
					})),
				);

			if (selectedSession) {
				const doId = selectedSession.jurisdiction ? platform.env.USER_SESSION.jurisdiction(selectedSession.jurisdiction).idFromString(sessionToken) : platform.env.USER_SESSION.idFromString(sessionToken);
				const doStub = platform.env.USER_SESSION.get(doId);

				const { b_time, lite_binding, normal_binding, sensitive_binding, generated_registration_options } = await doStub.getProperties(undefined, true);

				return {
					b_time: b_time!,
					expires: selectedSession.expires,
					lite_binding: lite_binding!,
					normal_binding: normal_binding!,
					sensitive_binding: sensitive_binding!,
					sessionToken,
					userId: hexToUuid(selectedSession.u_id),
					do_id: sessionToken,
					do_jurisdiction: selectedSession.jurisdiction,
					generated_registration_options: generated_registration_options!,
				} satisfies Exclude<Awaited<ReturnType<Exclude<Adapter['deleteSession'], undefined>>>, null>;
			} else {
				return null;
			}
		},
		// Email magic links
		getUserByEmail: async (email) => {
			// Sanity check - First that fires in chain for email magic link
			platform.ctx.waitUntil(
				r_db.delete(rootSchema.users).where(
					and(
						// DB never instantiated, now unrecoverable
						isNull(rootSchema.users.do_id),
						// Different that current key
						ne(rootSchema.users.key_hash, sql`unhex(${platformAuthSecretHash_hex})`),
					),
				),
			);
			const toUpdate = await r_db
				.select({
					u_id: rootSchema.users.u_id,
					jurisdiction: rootSchema.users.jurisdiction,
					do_id: rootSchema.users.do_id,
				})
				.from(rootSchema.users)
				.where(
					and(
						// DB instantiated, can get raw email from there
						isNotNull(rootSchema.users.do_id),
						// Different that current key
						ne(rootSchema.users.key_hash, sql`unhex(${platformAuthSecretHash_hex})`),
					),
				)
				.then((rows) =>
					rows.map((row) => ({
						...row,
						u_id: row.u_id.toString('hex'),
						do_id: row.do_id?.toString('hex') ?? null,
					})),
				);
			for (const dbPlaceholder of toUpdate) {
				const doStub = getUserD0(platform, r_db, dbPlaceholder.jurisdiction, dbPlaceholder.do_id ?? hexToUuid(dbPlaceholder.u_id));
				// Get raw email
				const { email } = await doStub
					.getProperties({ email: true }, true)
					// Zod will throw if email doesn't exist
					.catch(() => ({ email: undefined }));
				if (email) {
					await r_db
						.update(rootSchema.users)
						.set({
							key_hash: sql`unhex(${platformAuthSecretHash_hex})`,
							email_key: sql`unhex(${(await emailCanonicalize(platform, email)).digest('hex')})`,
						})
						.where(eq(rootSchema.users.do_id, sql`unhex(${dbPlaceholder.do_id})`))
						.limit(1);
				} else {
					// Unrecoverable, nuke and move on
					platform.ctx.waitUntil(doStub.nuke('Platform auth key changed - unrecoverable'));
					platform.ctx.waitUntil(
						r_db
							.delete(rootSchema.users)
							.where(eq(rootSchema.users.do_id, sql`unhex(${dbPlaceholder.do_id})`))
							.limit(1),
					);
				}
			}

			// Fetch user like normal now
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
				const u_id_utf8 = hexToUuid(u_id_hex);
				const do_id_hex = selectedUser.do_id?.toString('hex');

				const doStub = getUserD0(platform, r_db, selectedUser.jurisdiction, do_id_hex ?? u_id_utf8);
				const [{ email_verified }] = await Promise.all([
					doStub.getProperties({ email_verified: true }, true),
					doStub
						.getProperties({ email: true })
						.then(({ email }) => {
							if (email) {
								return;
							} else {
								// Email doesn't exist
								return doStub.updateProperties(
									{
										email,
										m_time: new Date(),
									},
									false,
									true,
								);
							}
						})
						// Email doesn't exist (zod threw error)
						.catch(() =>
							doStub.updateProperties(
								{
									email,
									m_time: new Date(),
								},
								false,
								true,
							),
						),
				]);

				return {
					id: u_id_utf8,
					u_id: {
						hex: u_id_hex,
						base64: selectedUser.u_id.toString('base64'),
						base64url: selectedUser.u_id.toString('base64url'),
					},
					do_jurisdiction: selectedUser.jurisdiction,
					do_id: do_id_hex,
					email,
					emailVerified: email_verified ?? null,
					image: emailToGravatar(email),
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
		getAuthenticator: (credentialID) => {
			console.debug('getAuthenticator', credentialID);
		},
		// @ts-expect-error @todo @demosjarco
		createAuthenticator: (authenticator) => {
			console.debug('createAuthenticator', authenticator);
		},
		// @ts-expect-error @todo @demosjarco
		listAuthenticatorsByUserId: (userId) => {
			console.debug('listAuthenticatorsByUserId', userId);
		},
		// @ts-expect-error @todo @demosjarco
		updateAuthenticatorCounter: (credentialID, newCounter) => {
			console.debug('updateAuthenticatorCounter', credentialID, newCounter);
		},
	};
}
