import { WorkerEntrypoint } from 'cloudflare:workers';
import type { EnvVars } from './types';

// Re-export every entrypoint so workerd can find them from this `main` file (see wrangler.jsonc's `main`).
export { BitwardenSessionProxy } from './entrypoints/BitwardenSessionProxy';
export { TenantD0LogsProxy } from './entrypoints/TenantD0LogsProxy';
export { TenantD0Proxy } from './entrypoints/TenantD0Proxy';
export { UserD0Proxy } from './entrypoints/UserD0Proxy';
export { UserSessionProxy } from './entrypoints/UserSessionProxy';

/**
 * This worker is only ever meant to be reached via service binding RPC, through one of the named entrypoints above. The default export exists so the worker still deploys cleanly and so an accidental direct HTTP hit gets a sane response instead of a crash.
 */
export default class extends WorkerEntrypoint<EnvVars> {
	override fetch() {
		return new Response(null, { status: 410 });
	}
}
