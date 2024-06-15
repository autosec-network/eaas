export interface EnvVars extends Secrets, Bindings, Partial<PagesEnvironmentvariables>, Record<string, any> {
	NODE_ENV: 'production' | 'development';
}

interface Secrets {}

interface Bindings {}

interface PagesEnvironmentvariables {
	CF_PAGES: '0' | '1';
	CF_PAGES_COMMIT_SHA: string;
	CF_PAGES_BRANCH: string;
	CF_PAGES_URL: string;
}

/**
 * @link https://developers.cloudflare.com/turnstile/troubleshooting/testing/#dummy-sitekeys-and-secret-keys
 */
export namespace TurnstileDummySitekey {
	export enum Visible {
		passes = '1x00000000000000000000AA',
		blocks = '2x00000000000000000000AB',
		interactive = '3x00000000000000000000FF',
	}
	export enum Invisible {
		passes = '1x00000000000000000000BB',
		blocks = '2x00000000000000000000BB',
	}
}
export enum TurnstileDummySecretkey {
	passes = '1x0000000000000000000000000000000AA',
	fails = '2x0000000000000000000000000000000AA',
	spent = '3x0000000000000000000000000000000AA',
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
