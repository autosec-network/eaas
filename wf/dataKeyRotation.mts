import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { EnvVars } from '../api/src/types.mjs';
import { DBManager, StaticDatabase } from '../shared/db-core/db.mjs';
import { tenants } from '../shared/db-preview/schemas/root';
import { BufferHelpers } from '../shared/helpers/buffers.mjs';
import { Helpers } from '../shared/helpers/index.mjs';
import { ZodUuidExportInput, type D1Blob } from '../shared/types/d1/index.mjs';

export const workflowParams = z.object({
	t_id: ZodUuidExportInput,
	kr_id: ZodUuidExportInput,
});

export type WorkflowParams = z.infer<typeof workflowParams>;

export class DataKeyRotation extends WorkflowEntrypoint<EnvVars, Params> {
	override async run(event: Readonly<WorkflowEvent<Params>>, step: WorkflowStep) {
		const parsedPayload = await step.do('zod parse payload', () =>
			workflowParams.parseAsync(typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload).catch((err) => {
				throw new NonRetryableError(JSON.stringify(err), 'Bad workflow payload');
			}),
		);

		const t_d1_id_utf8 = await step.do(
			'',
			{
				retries: {
					limit: Number.MAX_SAFE_INTEGER,
					/**
					 * CF global rate limit is 1200/5m
					 * @link https://developers.cloudflare.com/fundamentals/api/reference/limits/
					 */
					delay: 5 * 60 * 1000,
					backoff: 'constant',
				},
			},
			() =>
				BufferHelpers.uuidConvert(parsedPayload.t_id).then((t_id) => {
					let r_db: ReturnType<typeof DBManager.getDrizzle>;
					if (Helpers.isLocal(this.env.CF_VERSION_METADATA)) {
						r_db = DBManager.getDrizzle(
							{
								accountId: this.env.CF_ACCOUNT_ID,
								apiToken: this.env.CF_API_TOKEN,
								databaseId: this.env.ENVIRONMENT === 'production' ? StaticDatabase.Root.eaas_root : StaticDatabase.Root.eaas_root_p,
							},
							this.env.NODE_ENV !== 'production',
						);
					} else {
						r_db = DBManager.getDrizzle(this.env.EAAS_ROOT, this.env.NODE_ENV !== 'production');
					}

					return r_db
						.select({
							d1_id: tenants.d1_id,
						})
						.from(tenants)
						.where(eq(tenants.t_id, sql<D1Blob>`unhex(${t_id.hex})`))
						.limit(1)
						.then((rows) =>
							Promise.all(
								rows.map((row) =>
									BufferHelpers.uuidConvert(row.d1_id).then((d1_id) => ({
										...row,
										d1_id,
									})),
								),
							),
						)
						.then(([row]) => {
							if (row) {
								return row.d1_id.utf8;
							} else {
								throw new NonRetryableError('Tenant not found');
							}
						});
				}),
		);
	}
}
