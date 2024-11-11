import type SidecarWorker from '../../sidecar/src/index';

export interface EnvVars extends Secrets, Bindings, Partial<PagesEnvironmentvariables>, Record<string, any> {
	NODE_ENV: 'production' | 'development';

	TURNSTILE_SITE_KEY?: string;
}

interface Secrets {
	AUTH_SECRET: string;
	TURNSTILE_SECRET_KEY?: string;
}

interface Bindings {
	DB: D1Database;
	SIDECAR_WORKER: Service<SidecarWorker>;
}

interface PagesEnvironmentvariables {
	CF_PAGES: '0' | '1';
	CF_PAGES_COMMIT_SHA: string;
	CF_PAGES_BRANCH: string;
	CF_PAGES_URL: string;
}

/**
 * @link https://developers.cloudflare.com/turnstile/get-started/server-side-validation/#accepted-parameters
 */
export interface TurnstileResponse {
	success: boolean;
	/**
	 * the ISO timestamp for the time the challenge was solved
	 */
	challenge_ts: ReturnType<Date['toISOString']>;
	/**
	 * the hostname for which the challenge was served
	 */
	hostname: URL['hostname'];
	/**
	 * the customer widget identifier passed to the widget on the client side. This is used to differentiate widgets using the same sitekey in analytics. Its integrity is protected by modifications from an attacker. It is recommended to validate that the action matches an expected value
	 */
	action: string;
	/**
	 * the customer data passed to the widget on the client side. This can be used by the customer to convey state. It is integrity protected by modifications from an attacker
	 */
	cdata: string;
	/**
	 * a list of errors that occurred
	 */
	'error-codes': string[];
}
