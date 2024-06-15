import type { Provider } from '@auth/core/providers';
import GitHub from '@auth/core/providers/github';
import { serverAuth$ } from '@builder.io/qwik-auth';

export const { onRequest, useAuthSession, useAuthSignin, useAuthSignout } = serverAuth$(({ platform }) => ({
	secret: platform.env['AUTH_SECRET'],
	trustHost: true,
	providers: [
		GitHub({
			clientId: platform.env['GITHUB_ID'],
			clientSecret: platform.env['GITHUB_SECRET'],
		}),
	] satisfies Provider[],
}));
