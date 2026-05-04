import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { parseCronExpression } from 'cron-schedule';
import * as tenantSchema from 'db/schemas/tenant/main';
import { desc, eq, inArray, sql } from 'drizzle-orm/sql';
import { Buffer } from 'node:buffer';
import { Permissions } from 'types';
import type { ContextVariables, EnvVars } from '~/types';
import { APITags } from '~/v0/extras';
import { keyringOutput } from '~/v0/keyrings/shared';

const app = new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>();

export const route = createRoute({
	tags: [APITags['Keyring Management']],
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
});

app.openapi(route, async (c) => {
	const kr_ids = Object.keys(c.var.permissions).map((kr_id_base64url) => ({
		hex: Buffer.from(kr_id_base64url, 'base64url').toString('hex'),
	}));

	if ((c.var.globalPermissions && c.var.globalPermissions.r_keyrings > Permissions.None) || kr_ids.length > 0) {
		return c.var.t_db
			.select({
				kr_id: tenantSchema.keyrings.kr_id,
				name: tenantSchema.keyrings.name,
				b_time: tenantSchema.keyrings.b_time,
				c_time: tenantSchema.keyrings.c_time,
				key_type: tenantSchema.keyrings.key_type,
				key_size: tenantSchema.keyrings.key_size,
				hash: tenantSchema.keyrings.hash,
				m_time: tenantSchema.keyrings.m_time,
				time_rotation: tenantSchema.keyrings.time_rotation,
				count_rotation: tenantSchema.keyrings.count_rotation,
			})
			.from(tenantSchema.keyrings)
			.where(
				c.var.globalPermissions?.r_keyrings === Permissions.None
					? // @ts-expect-error map is fine because at least 1 exists
						inArray(
							tenantSchema.keyrings.kr_id,
							kr_ids.map((kr_id) => sql`unhex(${kr_id.hex})`),
						)
					: undefined,
			)
			.then((rows) =>
				rows.map((row) => ({
					...row,
					kr_id: {
						hex: row.kr_id.toString('hex'),
					},
					...(row.count_rotation && { count_rotation: BigInt(`0x${row.count_rotation.toString('hex')}`) }),
				})),
			)
			.then((rows) =>
				Promise.all(
					rows.map((row) =>
						c.var.t_db
							.select({
								generation_count: tenantSchema.datakeys.generation_count,
							})
							.from(tenantSchema.datakeys)
							.where(eq(tenantSchema.datakeys.kr_id, sql`unhex(${row.kr_id.hex})`))
							.orderBy(desc(tenantSchema.datakeys.dk_id))
							.limit(1)
							.then((rows) =>
								rows.map((row) => ({
									...row,
									generation_count: BigInt(`0x${row.generation_count.toString('hex')}`),
								})),
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
							})
							.then(
								(generation_count) =>
									({
										name: row.name,
										created: new Date(Number(BigInt(`0x${row.kr_id.hex.substring(0, 12)}`))).toISOString(),
										lastModified: row.c_time.toISOString(),
										key: {
											algorithm: row.key_type,
											size: row.key_size ?? null,
											hash: row.hash,
										},
										rotation: {
											lastRotation: row.m_time.toString(),
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
