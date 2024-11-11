import { WorkerEntrypoint } from 'cloudflare:workers';
import type { EnvVars } from './types';

export default class extends WorkerEntrypoint<EnvVars> {
	override async fetch() {
		return new Response('Hello world');
	}
}
