import { Container } from '@cloudflare/containers';
import type { EnvVars } from '~/types.mjs';

export class PqcContainerSidecar<E extends object = EnvVars> extends Container<E> {
	override defaultPort = 8080;

	override onError(error: unknown) {
		console.error('Container error:', error);
	}
}
