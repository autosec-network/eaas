import type { z } from '@hono/zod-openapi';
import type { ContextVariables, EnvVars } from '~/types.mjs';
import type { keyringOutput } from '~/v0/keyrings/shared.mjs';

const app = await import('@hono/zod-openapi').then(({ OpenAPIHono }) => new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>());

export const route = await Promise.all([import('@hono/zod-openapi'), import('~/v0/keyrings/shared.mjs')]).then(([{ createRoute, z }, { keyringOutput }]) =>
	createRoute({
		tags: ['keyring management'],
		method: 'get',
		path: '/',
		description: 'Get a list of keyrings.',
		request: {},
		responses: {
			200: {
				content: {
					'application/json': {
						schema: z.array(keyringOutput),
					},
				},
				description: 'Depending on key permissions, list all keyrings, or fallback to those the key has access to.',
			},
		},
	}),
);

app.openapi(route, async (c) => {
	const kr_ids = await import('~shared/helpers/buffers.mjs').then(({ BufferHelpers }) => Promise.all(Object.keys(c.var.permissions).map((kr_id_base64url) => BufferHelpers.uuidConvert(kr_id_base64url))));

	if ((c.var.globalPermissions && c.var.globalPermissions.r_keyrings > 0) || kr_ids.length > 0) {
		return Promise.all([import('~shared/db-preview/schemas/tenant'), import('~shared/types/d1/index.mjs'), import('drizzle-orm')])
			.then(([{ keyrings }, { Permissions }, { inArray, sql }]) =>
				c.var.t_db
					.select({
						kr_id: keyrings.kr_id,
						name: keyrings.name,
						b_time: keyrings.b_time,
						c_time: keyrings.c_time,
						key_type: keyrings.key_type,
						key_size: keyrings.key_size,
						hash: keyrings.hash,
						m_time: keyrings.m_time,
						time_rotation: keyrings.time_rotation,
						count_rotation: keyrings.count_rotation,
					})
					.from(keyrings)
					.where(
						c.var.globalPermissions?.r_keyrings === Permissions.None
							? // @ts-expect-error map is fine because at least 1 exists
								inArray(
									keyrings.kr_id,
									kr_ids.map((kr_id) => sql`unhex(${kr_id.hex})`),
								)
							: undefined,
					),
			)
			.then((rows) =>
				import('~shared/helpers/buffers.mjs').then(({ BufferHelpers }) =>
					Promise.all(
						rows.map((row) =>
							BufferHelpers.uuidConvert(row.kr_id).then(async (kr_id) => ({
								...row,
								kr_id,
								...(row.count_rotation && { count_rotation: await BufferHelpers.bufferToBigint(row.count_rotation) }),
							})),
						),
					),
				),
			)
			.then((rows) =>
				Promise.all(
					rows.map((row) =>
						Promise.all([
							import('cron-schedule'),
							Promise.all([import('~shared/db-preview/schemas/tenant'), import('drizzle-orm')]).then(([{ datakeys }, { eq, sql, desc }]) =>
								c.var.t_db
									.select({
										generation_count: datakeys.generation_count,
									})
									.from(datakeys)
									.where(eq(datakeys.kr_id, sql`unhex(${row.kr_id.hex})`))
									.orderBy(desc(datakeys.b_time))
									.limit(1)
									.then((rows) =>
										import('~shared/helpers/buffers.mjs').then(({ BufferHelpers }) =>
											Promise.all(
												rows.map((row) =>
													BufferHelpers.bufferToBigint(row.generation_count).then((generation_count) => ({
														...row,
														generation_count,
													})),
												),
											),
										),
									)
									.then(([row]) => {
										if (row) {
											return row.generation_count;
										} else {
											return BigInt(0);
										}
									})
									.catch((error) => {
										console.error(error);
										return BigInt(0);
									}),
							),
						]).then(
							([{ parseCronExpression }, generation_count]) =>
								({
									name: row.name,
									created: row.b_time,
									lastModified: row.c_time,
									key: {
										algorithm: row.key_type,
										size: row.key_size ?? null,
										hash: row.hash,
									},
									rotation: {
										lastRotation: row.m_time,
										time: {
											enabled: row.time_rotation,
											/**
											 * @todo Read from DO
											 */
											cron: ['0 0 1 1 *'],
											next:
												['0 0 1 1 *']
													.map((cron) => parseCronExpression(cron).getNextDate())
													.sort((a, b) => a.getTime() - b.getTime())[0]
													?.toISOString() ?? null,
										},
										count: {
											enabled: row.count_rotation !== null,
											threshold: ((row.count_rotation as bigint | null)?.toString() as unknown as bigint | null) ?? null,
											current: generation_count.toString() as unknown as bigint,
										},
									},
								}) satisfies z.infer<typeof keyringOutput>,
						),
					),
				),
			)
			.then((json) => c.json(json));
	} else {
		return c.json([] satisfies z.infer<typeof keyringOutput>[]);
	}
});

export default app;
