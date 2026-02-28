import type { EnvVars } from '~/types';

// @ts-expect-error this gets generated automatically later in the build process
import { fetch as assetFetch } from '../server/entry.cloudflare-pages';

export default {
	/**
	 * @link https://qwik.dev/docs/deployments/cloudflare-pages/#cloudflare-pages-entry-middleware
	 */
	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
	fetch: assetFetch,
} satisfies ExportedHandler<EnvVars>;
