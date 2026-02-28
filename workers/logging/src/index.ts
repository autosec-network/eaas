import { WorkerEntrypoint } from 'cloudflare:workers';

export default class extends WorkerEntrypoint {
	override queue(batch: MessageBatch<unknown>) {}
}
