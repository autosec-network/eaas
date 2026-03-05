import { DebugLogWriter } from 'db/core';
import * as tenantSchema from 'db/schemas/tenant';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { DefaultLogger } from 'drizzle-orm/logger';
import type { EnvVars } from '~/types.mjs';
import { BaseD0 } from '~do/BaseD0.mjs';

export class TenantD0 extends BaseD0 {
	protected override drizzle: DrizzleSqliteDODatabase<typeof tenantSchema>;

	constructor(ctx: DurableObjectState, env: EnvVars) {
		super(ctx, env);

		this.drizzle = drizzle(this._storage, {
			...(env.NODE_ENV !== 'production' && { logger: new DefaultLogger({ writer: new DebugLogWriter(ctx.id.toString()) }) }),
			casing: 'snake_case',
			schema: tenantSchema,
		});
	}

	protected override _migrate() {
		return Promise.all([import('drizzle-orm/durable-sqlite/migrator'), import('db/schemas/tenant/migrations')]).then(async ([{ migrate }, { default: migrations }]) =>
			migrate(
				await import('drizzle-orm/durable-sqlite').then(async ({ drizzle }) =>
					drizzle(this.ctx.storage, {
						...(this.env.NODE_ENV !== 'production' && { logger: await import('drizzle-orm/logger').then(async ({ DefaultLogger }) => new DefaultLogger({ writer: await import('db').then(({ DebugLogWriter, StaticDatabase }) => new DebugLogWriter(this.env.ENVIRONMENT === 'production' ? StaticDatabase.Root.eaas_root_prod : StaticDatabase.Root.eaas_root_dev)) })) }),
						casing: 'snake_case',
					}),
				),
				migrations,
			),
		);
	}
}
