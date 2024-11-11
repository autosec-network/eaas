import { D1Adapter } from '@auth/d1-adapter';
import { QwikAuth$ } from '@auth/qwik';
import Passkey from '@auth/qwik/providers/passkey';
import { DEFAULT_WEBAUTHN_TIMEOUT } from '@auth/qwik/providers/webauthn';

export const { onRequest, useSession, useSignIn, useSignOut } = QwikAuth$(({ platform }) => {
	const { cf } = platform.request;

	return {
		adapter: D1Adapter(platform.env.DB),
		providers: [
			Passkey({
				id: 'passkey',
				name: 'Passkey',
				authenticationOptions: {
					timeout: DEFAULT_WEBAUTHN_TIMEOUT,
					userVerification: 'preferred',
				},
				registrationOptions: {
					timeout: DEFAULT_WEBAUTHN_TIMEOUT,
					authenticatorSelection: {
						residentKey: 'preferred',
						userVerification: 'preferred',
					},
				},
				verifyAuthenticationOptions: {
					requireUserVerification: true,
				},
				verifyRegistrationOptions: {
					requireUserVerification: true,
				},
			}),
		],
		experimental: {
			enableWebAuthn: true,
		},
		debug: platform.env.NODE_ENV !== 'production',
		logger: {
			// Only debug log if not production
			debug: platform.env.NODE_ENV !== 'production' ? console.debug : undefined,
			// Keep the following to use nice console log separation
			warn: console.warn,
			error: console.error,
		},
		secret: platform.env.AUTH_SECRET,
		session: {
			strategy: 'database',
			// seconds * minutes * hours * days
			maxAge: 60 * 60 * 24 * 14,
		},
		trustHost: true,
	};
});
