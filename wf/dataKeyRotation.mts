import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { z } from 'zod';
import type { EnvVars } from '../api/src/types.mjs';

export const workflowParams = z.object({});

export type WorkflowParams = z.infer<typeof workflowParams>;

export class DataKeyRotation extends WorkflowEntrypoint<EnvVars, Params> {
	override async run(event: Readonly<WorkflowEvent<Params>>, step: WorkflowStep) {
		const parsedPayload = await step.do('zod parse payload', () =>
			workflowParams.parseAsync(typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload).catch((err) => {
				throw new NonRetryableError(JSON.stringify(err), 'Bad workflow payload');
			}),
		);
	}
}
