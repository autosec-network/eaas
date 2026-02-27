import { BaseD0 } from '~do/BaseD0.mjs';

export class TenantD0 extends BaseD0 {
	protected override _migrate() {
		return Promise.all([import('drizzle-orm/durable-sqlite/migrator'), import('~do/TenantD0/db/migrations.js')]).then(async ([{ migrate }, { default: migrations }]) =>
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
