/*
 * WHAT IS THIS FILE?
 *
 * It's the entry point for Cloudflare Pages when building for production.
 *
 * Learn more about the Cloudflare Pages integration here:
 * - https://qwik.dev/docs/deployments/cloudflare-pages/
 *
 */
import { createQwikCity, type PlatformCloudflarePages } from '@builder.io/qwik-city/middleware/cloudflare-pages';
import type { Request as CfRequest } from '@cloudflare/workers-types/experimental';
import qwikCityPlan from '@qwik-city-plan';
import { manifest } from '@qwik-client-manifest';
import type { PlatformProxy } from 'wrangler';
import render from './entry.ssr';
import type { EnvVars } from './types';

declare global {
	interface QwikCityPlatformLive extends Omit<PlatformCloudflarePages, 'request'> {
		request: CfRequest;
		env: EnvVars;
		ctx: ExecutionContext;
		cf: never;
	}
	interface QwikCityPlatformLocal extends PlatformProxy<EnvVars> {
		request?: never;
	}
	type QwikCityPlatform = QwikCityPlatformLive | QwikCityPlatformLocal;
}

const fetch = createQwikCity({ render, qwikCityPlan, manifest });

export { fetch };
