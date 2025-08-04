import { Container } from '@cloudflare/containers';
import type { EnvVars } from '~/types.mjs';

export class PqcContainerSidecar<E extends object = EnvVars> extends Container<E> {
	override defaultPort = 8080;
	override enableInternet = false;

	override onStart() {
		console.debug('Container successfully started');
	}

	override onStop() {
		console.debug('Container successfully shut down');
	}

	override onError(error: unknown) {
		console.error('Container error:', error);
	}
}
