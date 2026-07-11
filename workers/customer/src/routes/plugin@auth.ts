import Passkey from '@auth/core/providers/passkey';
import { DEFAULT_WEBAUTHN_TIMEOUT } from '@auth/core/providers/webauthn';
import { QwikAuth$ } from '@auth/qwik';
import { SQLCache } from 'db/cache';
import { DebugLogWriter, StaticDatabase } from 'db/core';
import * as rootSchema from 'db/schemas/root';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import { DefaultLogger } from 'drizzle-orm/logger';
import { count, eq, sql } from 'drizzle-orm/sql';
import type { UUID } from 'node:crypto';
import { DOJurisdictions } from 'types';
import * as zm from 'zod/mini';
import { D0Adapter } from '~/helpers/d0-adapter';
import type { Accept } from '~/routes/layout';
import { COSEAlgorithms, type UserD0 } from '~/types';

export async function emailCanonicalize(platform: QwikCityPlatform, rawEmail: string) {
	const stableEmail = rawEmail.trim().toLowerCase();
	const stableParts = stableEmail.split('@');
	const stableDomain = stableParts.pop()!;
	const stableLocal = stableParts.join('@');
	const stableBaseLocal = stableLocal.split('+', 1)[0]!;

	const canonicalizedEmail = `${stableBaseLocal}@${stableDomain}`;
	return (await import('node:crypto').then(({ createHmac }) => createHmac('sha256', Buffer.from(platform.env.AUTH_SECRET, 'base64')))).update(canonicalizedEmail);
}

export function getUserD0(platform: QwikCityPlatform, r_db: DrizzleD1Database, jurisdiction: DOJurisdictions | null, u_id_utf8: UUID): DurableObjectStub<UserD0>;
export function getUserD0(platform: QwikCityPlatform, r_db: DrizzleD1Database, jurisdiction: DOJurisdictions | null, do_id_hex: string): DurableObjectStub<UserD0>;
// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
export function getUserD0(platform: QwikCityPlatform, r_db: DrizzleD1Database, jurisdiction: DOJurisdictions | null, do_id_hexOrUid: UUID | string) {
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

	return platform.env.USER_D0.get(doId);
}

export async function hashBinding(bindingValues: (string | undefined)[] = []) {
	const hash = (await import('node:crypto').then(({ createHash }) => createHash('sha512'))).update(bindingValues.filter((value) => value !== undefined).join('')).digest();

	return hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength);
}

export async function getSessionBinding(cf: IncomingRequestCfProperties, headers: Headers) {
	const liteRaw = [cf.continent ?? '', cf.country ?? '', cf.region ?? '', cf.asn?.toString() ?? '', cf.asOrganization ?? '', JSON.stringify(cf.tlsClientAuth), cf.timezone ?? '', headers.get('Accept-Language') ?? ''];
	const normalRaw = [...liteRaw, cf.tlsCipher, cf.tlsVersion, cf.httpProtocol];
	const sensitiveRaw = [...normalRaw, headers.get('User-Agent') ?? '', headers.get('CF-Connecting-IP') ?? ''];

	return Promise.all([hashBinding(liteRaw), hashBinding(normalRaw), hashBinding(sensitiveRaw)]).then(([liteHash, normalHash, sensitiveHash]) => ({
		lite: liteHash,
		normal: normalHash,
		sensitive: sensitiveHash,
		debug: {
			lite: liteRaw,
			normal: normalRaw,
			sensitive: sensitiveRaw,
		},
	}));
}

function getLocale(platform: QwikCityPlatform, request: Request) {
	const headers = (platform.request ?? request).headers;

	const parseParams = (paramParts: string[]): Record<string, string> => {
		return paramParts.reduce<Record<string, string>>((acc, param) => {
			const [key, val] = param.split('=').map((s) => s.trim());
			if (key && val) {
				acc[key] = val;
			}
			return acc;
		}, {});
	};
	const parseQuality = (qVal?: string): number => {
		if (qVal === undefined) {
			return 1;
		}
		if (qVal === '') {
			return 1;
		}
		if (qVal === 'NaN') {
			return 0;
		}

		const num = Number(qVal);
		if (num === Infinity) {
			return 1;
		}
		if (num === -Infinity) {
			return 0;
		}
		if (Number.isNaN(num)) {
			return 1;
		}
		if (num < 0 || num > 1) {
			return 1;
		}

		return num;
	};

	const parseAcceptValue = ({ value, index }: { value: string; index: number }) => {
		const parseAcceptValueRegex = /;(?=(?:(?:[^"]*"){2})*[^"]*$)/;
		const parts = value
			.trim()
			.split(parseAcceptValueRegex)
			.map((s) => s.trim());
		const type = parts[0];
		if (!type) {
			return null;
		}

		const params = parseParams(parts.slice(1));
		const q = parseQuality(params['q']);

		return { type, params, q, index };
	};
	const sortByQualityAndIndex = (a: Accept & { index: number }, b: Accept & { index: number }) => {
		const qDiff = b.q - a.q;
		if (qDiff !== 0) {
			return qDiff;
		}
		return a.index - b.index;
	};

	const parseAccept = (acceptHeader: string): Accept[] => {
		if (!acceptHeader) {
			return [];
		}

		const acceptValues = acceptHeader.split(',').map((value, index) => ({ value, index }));

		return acceptValues
			.map(parseAcceptValue)
			.filter((item): item is Accept & { index: number } => Boolean(item))
			.sort(sortByQualityAndIndex)
			.map(({ type, params, q }) => ({ type, params, q }));
	};

	function parseAcceptLanguage(header: string): { lang: string; q: number }[] {
		return parseAccept(header).map(({ type, q }) => ({ lang: type, q }));
	}

	if (headers.has('Accept-Language')) {
		const parsedLocales = parseAcceptLanguage(headers.get('Accept-Language')!);
		return parsedLocales[0]?.lang;
	}

	return 'en';
}
function getTimezone(platform: QwikCityPlatform, request: Request) {
	const long = ((platform.request ?? platform).cf as IncomingRequestCfProperties).timezone;

	return {
		long,
		short: new Intl.DateTimeFormat(getLocale(platform, request), { timeZoneName: 'short', timeZone: long }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value,
	} as const;
}

export const { onRequest, useSession, useSignIn, useSignOut } = QwikAuth$(({ platform, sharedMap, request }) => {
	const headers = (platform.request ?? request).headers;
	const cacheControl = new Set((headers.get('Cache-Control')?.split(',') ?? []).map((directive) => directive.trim().toLowerCase()));
	// RFC 7234: no-store forbids storing; no-cache/zero max-age require revalidation so we skip reads
	const toCache = !(cacheControl.has('no-store') || cacheControl.has('no-cache') || cacheControl.has('max-age=0') || cacheControl.has('s-maxage=0'));

	const r_db = drizzle(platform.env.DB_ROOT.withSession('first-unconstrained') as unknown as D1Database, {
		...(platform.env.NODE_ENV !== 'production' && { logger: new DefaultLogger({ writer: new DebugLogWriter(platform.env.ENVIRONMENT === 'production' ? StaticDatabase.Root.eaas_root_prod : StaticDatabase.Root.eaas_root_dev) }) }),
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
		adapter: D0Adapter(platform, sharedMap, request, r_db, toCache),
		providers: [
			{
				id: 'email',
				name: 'Email',
				type: 'email',
				maxAge: 5 * 60,
				sendVerificationRequest: async ({ identifier: email, url, expires }) => {
					const { messageId } = await platform.env.EMAIL.send({
						headers: {
							'Auto-Submitted': 'auto-generated',
							'Content-Language': 'en',
							'Require-Recipient-Valid-Since': ((sharedMap.get('u_id_date') as Date | undefined) ?? new Date()).toUTCString(),
							...((platform.request ?? request).headers.has('Cf-Ray') && { 'X-Entity-Ref-ID': (platform.request ?? request).headers.get('Cf-Ray')! }),
						},
						from: 'system@eaas.autosec.network',
						to: email,
						subject: '[Autosec EaaS] Sign-in link',
						text: [`A sign-in request for ${email}`, 'Use the link below to continue securely. The link can only be used for a short time.', url, `This link expires in 5 minutes (${expires.toLocaleString(getLocale(platform, request), { timeZone: getTimezone(platform, request).long })} ${getTimezone(platform, request).short})`].join('\n\n'),
					});

					if (platform.env.NODE_ENV !== 'production') console.debug(`Email sent (id: ${messageId})`);
				},
			},
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
			// Only invited users
			signIn: async ({ user }) => {
				if (user.email) {
					const [row] = await r_db
						.select({ count: count() })
						.from(rootSchema.users)
						.where(eq(rootSchema.users.email_key, sql`unhex(${(await emailCanonicalize(platform, user.email)).digest('hex')})`))
						.limit(1);

					return (row?.count ?? 0) > 0;
				}

				return false;
			},
			// This needs to remain here (even if no-op) or else all custom session properties will be stripped out by the default callback
			session: ({ session }) => session,
		},
		events: {
			signIn: ({ user, account }) => {
				/**
				 *  Update access timestamp
				 */
				// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
				const doStub = getUserD0(platform, r_db, null, user.do_id ?? user.id);
				platform.ctx.waitUntil(doStub.updateProperties({ a_time: new Date() }, true, true));

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
			createUser: ({ user }) => {
				console.debug('createUser event', user);
			},
			updateUser: ({ user }) => {
				console.debug('updateUser event', user);
			},
		},
		debug: platform.env.NODE_ENV !== 'production',
		logger: {
			// Only debug log if not production
			debug: platform.env.NODE_ENV !== 'production' ? console.debug : undefined,
			// Keep the following to use nice console log separation
			warn: console.warn,
			error: console.error,
		},
		pages: {
			signIn: '/login',
			error: '/login/error',
			verifyRequest: '/login/verify',
		},
		secret: platform.env.AUTH_SECRET,
		session: {
			strategy: 'database',
			maxAge: parseInt(platform.env.SESSION_TTL, 10),
			generateSessionToken: () => (((platform.request ?? platform).cf as IncomingRequestCfProperties).isEUCountry === '1' ? platform.env.USER_SESSION.jurisdiction('eu') : platform.env.USER_SESSION).newUniqueId().toString(),
		},
		trustHost: true,
	};
});
