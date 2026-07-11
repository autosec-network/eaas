import { server$ } from '@builder.io/qwik-city';
import type { TurnstileObject } from 'turnstile-types';
import type { TurnstileRequest, TurnstileResponse } from '~/types';

export const turnstileVerify = server$(function (turnstileResponse: ReturnType<TurnstileObject['getResponse']>) {
	return fetch(new URL('https://challenges.cloudflare.com/turnstile/v0/siteverify'), {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			secret: !('GIT_HASH' in this.platform.env)
				? /**
					 * Always passes validation
					 * @link https://developers.cloudflare.com/turnstile/troubleshooting/testing/#test-secret-keys
					 */
					'1x0000000000000000000000000000000AA'
				: this.platform.env.TURNSTILE_SECRET_KEY,
			response: turnstileResponse,
			...(this.request.headers.has('CF-Connecting-IP') && { remoteip: this.request.headers.get('CF-Connecting-IP')! }),
		} satisfies TurnstileRequest),
	}).then((response) => response.json<TurnstileResponse>());
});
