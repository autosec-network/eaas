import { DurableObject } from 'cloudflare:workers';
import type { EnvVars } from '~/types.mjs';
import { proxyFetch, startAndWaitForPort } from '~pqc/do/containerHelpers.mjs';

export class PqcContainerSidecar<E extends object = EnvVars> extends DurableObject<E> {
	public static OPEN_CONTAINER_PORT = 8080;

	constructor(ctx: PqcContainerSidecar<E>['ctx'], env: PqcContainerSidecar<E>['env']) {
		super(ctx, env);

		if (ctx.container) {
			ctx.blockConcurrencyWhile(async () => {
				await startAndWaitForPort(ctx.container!, PqcContainerSidecar.OPEN_CONTAINER_PORT);
			});
		} else {
			throw new Error('Container context not available');
		}
	}

	override async fetch(request: Request) {
		if (this.ctx.container) {
			return await proxyFetch(this.ctx.container, request, PqcContainerSidecar.OPEN_CONTAINER_PORT);
		} else {
			return new Response('Container not available', {
				status: 503,
				headers: {
					'Content-Type': 'text/plain',
				},
			});
		}
	}
}
