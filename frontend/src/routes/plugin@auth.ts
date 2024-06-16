import Passkey from '@auth/core/providers/passkey';
import { D1Adapter } from '@auth/d1-adapter';
import { serverAuth$ } from '@builder.io/qwik-auth';

export const { onRequest, useAuthSession, useAuthSignin, useAuthSignout } = serverAuth$(({ platform }) => ({
	adapter: D1Adapter(platform.env.DB),
	providers: [Passkey],
	experimental: {
		enableWebAuthn: true,
	},
	logger: {
		// Only debug log if not production
		debug: platform.env.NODE_ENV !== 'production' ? console.debug : undefined,
		// Keep the following to use nice console log separation
		warn: console.warn,
		error: console.error,
	},
	basePath: '/auth',
	secret: platform.env.AUTH_SECRET,
	session: {
		generateSessionToken: crypto.randomUUID,
		// seconds * minutes * hours * days
		maxAge: 60 * 60 * 24 * 14,
	},
	trustHost: true,
	useSecureCookies: true,
}));
