import Passkey from '@auth/core/providers/passkey';
import { DEFAULT_WEBAUTHN_TIMEOUT } from '@auth/core/providers/webauthn';
import { QwikAuth$ } from '@auth/qwik';
import GitHub from '@auth/qwik/providers/github';
import { DebugLogWriter, StaticDatabase } from 'db/core';
import * as rootSchema from 'db/schemas/root';
import { drizzle } from 'drizzle-orm/d1';
import { DefaultLogger } from 'drizzle-orm/logger';
import { eq, sql } from 'drizzle-orm/sql';
import { SQLCache } from 'helpers/db';
import { D0Adapter } from '~/helpers/d0-adapter';
import { COSEAlgorithms } from '~/types';

export const { onRequest, useSession, useSignIn, useSignOut } = QwikAuth$(({ platform, request }) => {
	const sqlLogger = false;
	const headers = (platform.request ?? request).headers;
	const cacheControl = new Set((headers.get('Cache-Control')?.split(',') ?? []).map((directive) => directive.trim().toLowerCase()));
	// RFC 7234: no-store forbids storing; no-cache/zero max-age require revalidation so we skip reads
	const toCache = !(cacheControl.has('no-store') || cacheControl.has('no-cache') || cacheControl.has('max-age=0') || cacheControl.has('s-maxage=0'));

	const r_db = drizzle(platform.env.DB_ROOT.withSession('first-unconstrained') as unknown as D1Database, {
		...(platform.env.NODE_ENV !== 'production' && { logger: new DefaultLogger({ writer: new DebugLogWriter(platform.env.ENVIRONMENT === 'production' ? StaticDatabase.Root.eaas_root_prod : StaticDatabase.Root.eaas_root_dev) }) }),
		schema: rootSchema,
		casing: 'snake_case',
		cache: new SQLCache(
			{
				dbName: platform.env.ENVIRONMENT === 'production' ? StaticDatabase.Root.eaas_root_prod : StaticDatabase.Root.eaas_root_dev,
				dbType: 'd1',
				strategy: 'all',
				cacheTTL: parseInt(platform.env.SQL_TTL, 10),
				logging: platform.env.NODE_ENV !== 'production',
			},
			platform.caches ?? globalThis.caches,
		),
	});

	return {
		adapter: D0Adapter(platform, r_db, toCache),
		providers: [
			GitHub,
			Passkey({
				registrationOptions: {
					attestationType: 'indirect',
					supportedAlgorithmIDs: [
						// PQC algos
						COSEAlgorithms['ChaCha20/Poly1305'],
						COSEAlgorithms['ML-DSA-87'],
						COSEAlgorithms['ML-DSA-65'],
						COSEAlgorithms['ML-DSA-44'],
						COSEAlgorithms['HSS-LMS'],
						// Eliptic curves
						COSEAlgorithms.ESP512,
						COSEAlgorithms.ESP384,
						COSEAlgorithms.ESP256,
						COSEAlgorithms.Ed25519,
						COSEAlgorithms.Ed448,
						// Ancient RSA
						COSEAlgorithms.PS512,
						COSEAlgorithms.PS384,
						COSEAlgorithms.PS256,
						COSEAlgorithms['RSAES-OAEP w/ SHA-512'],
						COSEAlgorithms['RSAES-OAEP w/ SHA-256'],
						// IANA Deprecated (But windows hello lives under a rock)
						COSEAlgorithms.ES512,
						COSEAlgorithms.ES384,
						COSEAlgorithms.ES256,
					],
					timeout: DEFAULT_WEBAUTHN_TIMEOUT,
				},
			}),
		],
		experimental: { enableWebAuthn: true },
		callbacks: {
			session: async ({ session }) => {
				const now = new Date();
				if (new Date(session.expires) < now) {
					console.error(new Error('Session expired', { cause: { expired: new Date(session.expires), current: now } }));
					// eslint-disable-next-line qwik/use-method-usage
					await useSignOut().submit({});
				}

				/**
				 * @todo Session verification logic
				 */

				return session;
			},
		},
		events: {
			signIn: ({ user, account, profile }) => {
				/**
				 *  Update access timestamp
				 */
				/**
				 * @todo Update `a_time` in user d0
				 */

				/**
				 * Update generic profile
				 */
				if (profile && (profile.name || profile.email || profile.picture)) {
					const emailKey = (() => {
						if (profile.email) {
							const stableEmail = profile.email.trim().toLowerCase();
							const stableParts = stableEmail.split('@');
							const stableDomain = stableParts.pop()!;
							const stableLocal = stableParts.join('@');
							const stableBaseLocal = stableLocal.split('+', 1)[0]!;

							const canonicalizedEmail = `${stableBaseLocal}@${stableDomain}`;
							return import('node:crypto').then(({ createHmac }) => createHmac('sha256', Buffer.from(platform.env.AUTH_SECRET, 'base64')).update(canonicalizedEmail).digest('hex'));
						} else {
							return undefined;
						}
					})();

					// Update in user d0
					/**
					 * @todo
					 */

					// Update in root
					if (emailKey) {
						platform.ctx.waitUntil(
							import('node:crypto').then(({ createHash }) =>
								r_db
									.update(rootSchema.users)
									.set({
										key_hash: sql`unhex(${createHash('sha256').update(Buffer.from(platform.env.AUTH_SECRET, 'base64').toString('hex')).digest('hex')})`,
										email_key: sql`unhex(${emailKey})`,
									})
									.where(eq(rootSchema.users.u_id, sql`unhex(${user.u_id.hex})`)),
							),
						);
					}
				}

				/**
				 * Update tokens
				 * Keep up to date with `linkAccount` in `d1-adapter.ts`
				 */
				if (account?.providerAccountId && (account.refresh_token || account.access_token || account.scope || account.expires_at || account.id_token)) {
					/**
					 * @todo
					 */
				}
			},
		},
		debug: true,
		logger: {
			// Only debug log if not production
			debug: console.debug,
			// Keep the following to use nice console log separation
			warn: console.warn,
			error: console.error,
		},
		pages: {
			signIn: '/login',
		},
		secret: platform.env.AUTH_SECRET,
		session: {
			strategy: 'database',
			// days * hours * minutes * seconds
			maxAge: 14 * 24 * 60 * 60,
			generateSessionToken: () => platform.env.USER_SESSION.newUniqueId().toString(),
		},
		trustHost: true,
	};
});
