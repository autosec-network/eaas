/**
 * Custom adapter for D1/DO API, attempting to keep same usability as `@auth/d1-adapter`
 * @link https://github.com/nextauthjs/next-auth/tree/main/packages/adapter-d1
 */
import type { Adapter } from '@auth/core/adapters';
import { SQLCache } from 'db/cache';
import { drizzleD0 } from 'db/core';
import * as rootSchema from 'db/schemas/root';
import * as userSchema from 'db/schemas/user/main';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { and, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm/sql';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import { hexToUuid } from 'helpers';
import { createHash, type UUID } from 'node:crypto';
import { DOJurisdictions } from 'types';
import * as zm from 'zod/mini';
import { deriveId, isLocal, resolveDoStub, type DOLocator } from '~/helpers/do-proxy';
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

/**
 * Deletes a session from the root database and nukes the corresponding Durable Object.
 * @param {QwikCityPlatform} platform - The Qwik City platform instance containing environment variables and context
 * @param {DrizzleD1Database} r_db - The root database connection
 * @param {string} sessionToken - The session token to delete
 * @param {boolean} returning - If true, returns the deleted session data; if false, returns undefined
 * @returns {Promise<object|undefined|null>} The deleted session data if returning is true, undefined if session exists but returning is false, or null if session was not found
 */
export async function deleteSession(platform: QwikCityPlatform, r_db: DrizzleD1Database, sessionToken: string, returning: boolean) {
	// Delete from root lookup
	const [deletedSession] = await r_db
		.delete(rootSchema.users_auth_sessions)
		.where(eq(rootSchema.users_auth_sessions.session_token, sql`unhex(${sessionToken})`))
		.limit(1)
		.returning({
			u_id: rootSchema.users_auth_sessions.u_id,
			expires: rootSchema.users_auth_sessions.expires,
		})
		.then((rows) =>
			rows.map((row) => ({
				...row,
				u_id: row.u_id.toString('hex'),
			})),
		);

	if (deletedSession) {
		// Try can get jurisdiction
		const [selectedUser] = await r_db
			.select({
				jurisdiction: rootSchema.users.jurisdiction,
			})
			.from(rootSchema.users)
			.where(eq(rootSchema.users.u_id, sql`unhex(${deletedSession.u_id})`))
			.limit(1);

		if (selectedUser) {
			const doStub = resolveDoStub(platform, platform.env.USER_SESSION, platform.env.USER_SESSION_PROXY, { id: sessionToken, jurisdiction: selectedUser.jurisdiction ?? undefined });

			// Get properties before nuke, since after that they will be inaccessible
			const { b_time, lite_binding, normal_binding, sensitive_binding, generated_registration_options, binding_debug } = returning ? await doStub.getProperties(undefined, true) : {};

			platform.ctx.waitUntil(doStub.nuke('Session deleted'));

			if (returning) {
				return {
					b_time: b_time!,
					expires: deletedSession.expires,
					lite_binding: Buffer.from(lite_binding!).toString('base64'),
					normal_binding: Buffer.from(normal_binding!).toString('base64'),
					sensitive_binding: Buffer.from(sensitive_binding!).toString('base64'),
					sessionToken,
					userId: hexToUuid(deletedSession.u_id),
					do_id: sessionToken,
					do_jurisdiction: selectedUser.jurisdiction,
					// @ts-expect-error Type instanciation too deep
					generated_registration_options: generated_registration_options!,
					binding_debug: binding_debug!,
				}; // satisfies Exclude<Awaited<ReturnType<Exclude<Adapter['deleteSession'], undefined>>>, null>;
			} else {
				return undefined;
			}
		}
	}

	// Try to nuke session DO even if session wasn't found in DB, since it's orphaned
	for (const jurisdiction of [...Object.values(DOJurisdictions), null]) {
		try {
			const doStub = resolveDoStub(platform, platform.env.USER_SESSION, platform.env.USER_SESSION_PROXY, { id: sessionToken, jurisdiction: jurisdiction ?? undefined });
			platform.ctx.waitUntil(doStub.nuke('Session deleted'));
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
		} catch (error) {
			// Ignore errors, since session might not exist in some or all jurisdictions
		}
	}

	return null;
}

export function D0Adapter(platform: QwikCityPlatform, sharedMap: Map<string, any>, request: Request, r_db: DrizzleD1Database, toCache: boolean): Adapter {
	const platformAuthSecretHash_hex = createHash('sha256').update(Buffer.from(platform.env.AUTH_SECRET, 'base64').toString('hex')).digest('hex');

	function getUserDb(jurisdiction: DOJurisdictions | null, u_id_utf8: UUID): SqliteRemoteDatabase;
	function getUserDb(jurisdiction: DOJurisdictions | null, do_id_hex: string): SqliteRemoteDatabase;
	// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
	function getUserDb(jurisdiction: DOJurisdictions | null, do_id_hexOrUid: UUID | string) {
		// Locally we can't derive a jurisdictional id (workerd throws), so defer that to the proxy and leave the derivation-carrying locator raw.
		const local = isLocal(platform) && !!platform.env.USER_D0_PROXY;

		const locator = zm
			.union([
				zm.pipe(
					zm.uuidv7(),
					zm.transform((u_id_utf8): DOLocator => {
						// Are they really not in the EU?
						const currentlyEu = ((platform.request ?? platform).cf as IncomingRequestCfProperties).isEUCountry === '1';

						// Last chance for us to change jurisdiction, can't change after db is instantiated
						const effectiveJurisdiction = jurisdiction === null && currentlyEu ? DOJurisdictions['The European Union'] : (jurisdiction ?? undefined);

						platform.ctx.waitUntil(
							r_db
								.update(rootSchema.users)
								.set({
									jurisdiction: (jurisdiction ?? currentlyEu) ? DOJurisdictions['The European Union'] : null,
									// Cache do_id only when we can derive it (deployed). Local dev leaves it null (column is nullable) — reads re-derive from the name via `idFromName`.
									...(local ? {} : { do_id: sql`unhex(${deriveId(platform.env.USER_D0, { name: u_id_utf8, jurisdiction: effectiveJurisdiction }).toString()})` }),
								})
								.where(eq(rootSchema.users.u_id, sql`unhex(${u_id_utf8.replaceAll('-', '')})`)),
						);

						return { name: u_id_utf8, jurisdiction: effectiveJurisdiction };
					}),
				),
				zm.pipe(
					zm.hex().check(zm.length(64)),
					zm.transform((do_id_hex): DOLocator => ({ id: do_id_hex, jurisdiction: jurisdiction ?? undefined })),
				),
			])
			.parse(do_id_hexOrUid);
		const doStub = resolveDoStub(platform, platform.env.USER_D0, platform.env.USER_D0_PROXY, locator);

		return drizzleD0(doStub, {
			cache: new SQLCache(
				{
					// Stable cache key: the resolved id hex when deployed, else whatever identifies the locator locally.
					dbName: local ? (locator.id ?? locator.name!) : deriveId(platform.env.USER_D0, locator).toString(),
					dbType: 'do',
					strategy: toCache ? 'all' : 'explicit',
					cacheTTL: parseInt(platform.env.SQL_TTL, 10),
				},
				platform.caches ?? globalThis.caches,
			),
		});
	}

	return {
		// Unknown
		deleteUser: (userId) => {
			console.debug('deleteUser', userId);
		},
		// @ts-expect-error @todo @demosjarco
		getUserByAccount: (providerAccountId) => {
			console.debug('getUserByAccount', providerAccountId);
		},
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
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
			// A jurisdictional session needs a fresh jurisdictional id (the previous one has no jurisdiction). Minting `newUniqueId()` under a jurisdiction can't happen in local workerd, so mint it on the proxy; non-jurisdictional sessions reuse the token minted by `generateSessionToken`.
			const local = isLocal(platform) && !!platform.env.USER_SESSION_PROXY;
			const sessionToken = selectedUser?.jurisdiction ? (local ? await platform.env.USER_SESSION_PROXY!.newUniqueId(selectedUser.jurisdiction) : platform.env.USER_SESSION.jurisdiction(selectedUser.jurisdiction).newUniqueId().toString()) : session.sessionToken;

			const [{ lite, normal, sensitive, debug }] = await Promise.all([
				getSessionBinding((platform.request ?? platform).cf as IncomingRequestCfProperties, (platform.request ?? request).headers),
				r_db.insert(rootSchema.users_auth_sessions).values({
					u_id: sql`unhex(${session.userId.replaceAll('-', '')})`,
					session_token: sql`unhex(${sessionToken})`,
					expires: session.expires,
				}),
			]);

			const doStub = resolveDoStub(platform, platform.env.USER_SESSION, platform.env.USER_SESSION_PROXY, { id: sessionToken, jurisdiction: selectedUser?.jurisdiction ?? undefined });
			await doStub.updateProperties(
				{
					b_time,
					lite_binding: lite,
					normal_binding: normal,
					sensitive_binding: sensitive,
					binding_debug: debug,
				},
				false,
				true,
			);

			return {
				...session,
				sessionToken,
				b_time,
				do_jurisdiction: selectedUser?.jurisdiction ?? null,
				do_id: sessionToken,
				lite_binding: Buffer.from(lite).toString('base64'),
				normal_binding: Buffer.from(normal).toString('base64'),
				sensitive_binding: Buffer.from(sensitive).toString('base64'),
				binding_debug: debug,
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
					})),
				);

			if (selectedUserSession) {
				const u_id_hex = selectedUserSession.u_id.toString('hex');
				const u_id_utf8 = hexToUuid(u_id_hex);

				const sessionLocator: DOLocator = { id: sessionToken, jurisdiction: selectedUserSession.jurisdiction ?? undefined };

				return Promise.all([
					(async () => {
						const doStub = resolveDoStub(platform, platform.env.USER_SESSION, platform.env.USER_SESSION_PROXY, sessionLocator);

						const { b_time, lite_binding, normal_binding, sensitive_binding, generated_registration_options, binding_debug } = await doStub.getProperties(undefined, true);

						return {
							b_time: b_time!,
							expires: selectedUserSession.expires,
							lite_binding: Buffer.from(lite_binding!).toString('base64'),
							normal_binding: Buffer.from(normal_binding!).toString('base64'),
							sensitive_binding: Buffer.from(sensitive_binding!).toString('base64'),
							sessionToken,
							userId: u_id_utf8,
							do_id: sessionToken,
							do_jurisdiction: selectedUserSession.jurisdiction,
							generated_registration_options: generated_registration_options!,
							binding_debug: binding_debug!,
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
				])
					.then(([session, user]) => ({ session, user }) satisfies Exclude<Awaited<ReturnType<Exclude<Adapter['getSessionAndUser'], undefined>>>, null>)
					.catch((error) => {
						console.error('Error getting session and user', error instanceof zm.core.$ZodError ? zm.prettifyError(error) : error);

						// Nuke
						const doStub = resolveDoStub(platform, platform.env.USER_SESSION, platform.env.USER_SESSION_PROXY, sessionLocator);
						platform.ctx.waitUntil(doStub.nuke("Corrupted session - couldn't get properties"));

						return null;
					});
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
					})),
				);

			if (selectedSession) {
				const doStub = resolveDoStub(platform, platform.env.USER_SESSION, platform.env.USER_SESSION_PROXY, { id: sessionToken, jurisdiction: selectedSession.jurisdiction ?? undefined });

				if ('b_time' in session || 'lite_binding' in session || 'normal_binding' in session || 'sensitive_binding' in session) {
					await doStub.updateProperties(
						{
							...('b_time' in session && { b_time: session.b_time }),
							...('lite_binding' in session && {
								lite_binding: (() => {
									const buffer = Buffer.from(session.lite_binding!, 'base64');
									return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
								})(),
							}),
							...('normal_binding' in session && {
								normal_binding: (() => {
									const buffer = Buffer.from(session.normal_binding!, 'base64');
									return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
								})(),
							}),
							...('sensitive_binding' in session && {
								sensitive_binding: (() => {
									const buffer = Buffer.from(session.sensitive_binding!, 'base64');
									return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
								})(),
							}),
							...('generated_registration_options' in session && { generated_registration_options: session.generated_registration_options }),
						},
						false,
						true,
					);
				}

				const { b_time, lite_binding, normal_binding, sensitive_binding, generated_registration_options, binding_debug } = await doStub.getProperties(
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
					lite_binding: session.lite_binding ?? Buffer.from(lite_binding!).toString('base64'),
					normal_binding: session.normal_binding ?? Buffer.from(normal_binding!).toString('base64'),
					sensitive_binding: session.sensitive_binding ?? Buffer.from(sensitive_binding!).toString('base64'),
					sessionToken,
					userId: hexToUuid(selectedSession.u_id),
					do_id: sessionToken,
					do_jurisdiction: selectedSession.jurisdiction,
					generated_registration_options: session.generated_registration_options ?? generated_registration_options,
					binding_debug: binding_debug!,
				} satisfies Exclude<Awaited<ReturnType<Exclude<Adapter['updateSession'], undefined>>>, null>;
			} else {
				return null;
			}
		},
		deleteSession: async (sessionToken) => {
			console.debug('deleteSession', sessionToken);

			return deleteSession(platform, r_db, sessionToken, true);
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
			platform.ctx.waitUntil(
				r_db
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
					)
					.then(async (toUpdate) => {
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
								await doStub.nuke('Platform auth key changed - unrecoverable');
								await r_db
									.delete(rootSchema.users)
									.where(eq(rootSchema.users.do_id, sql`unhex(${dbPlaceholder.do_id})`))
									.limit(1);
							}
						}
					}),
			);

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
				sharedMap.set('u_id_date', new Date(parseInt(u_id_hex.slice(0, 12), 16)));
				const u_id_utf8 = hexToUuid(u_id_hex);
				const do_id_hex = selectedUser.do_id?.toString('hex');

				const doStub = getUserD0(platform, r_db, selectedUser.jurisdiction, do_id_hex ?? u_id_utf8);
				const [{ email_verified }] = await Promise.all([
					doStub.getProperties({ email_verified: true }, true).catch(() =>
						doStub
							.updateProperties(
								{
									email_verified: null,
								},
								false,
								true,
							)
							.then(() => ({ email_verified: null })),
					),
					doStub
						.getProperties({ email: true }, true)
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
					expires: verificationToken.expires,
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
						expires: userSchema.auth_verification_token.expires,
					})
					.from(userSchema.auth_verification_token)
					.where(eq(userSchema.auth_verification_token.hashed_token, sql`unhex(${token})`));

				if (selectedToken) {
					// Prevent re-use
					await u_db.delete(userSchema.auth_verification_token).where(eq(userSchema.auth_verification_token.hashed_token, sql`unhex(${token})`));

					return {
						identifier,
						token,
						expires: selectedToken.expires,
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
