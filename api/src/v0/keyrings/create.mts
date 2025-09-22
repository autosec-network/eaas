import { BufferHelpers } from '@chainfuse/helpers/buffers';
import { createRoute, OpenAPIHono, type z } from '@hono/zod-openapi';
import { parseCronExpression } from 'cron-schedule';
import { sql } from 'drizzle-orm/sql';
import type { Buffer } from 'node:buffer';
import type { ContextVariables, EnvVars } from '~/types.mjs';
import { APITags } from '~/v0/extras.mjs';
import { keyringEditable, keyringOutput } from '~/v0/keyrings/shared.mjs';
import { keyrings } from '~shared/db-preview/schemas/tenant';
import type { workersCryptoCatalog } from '~shared/types/crypto/workers-crypto-catalog.mjs';
import type { workflowParams } from '~wf/dataKeyRotation.mjs';

const app = new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>();

app.use('*', async (c, next) => {
	/**
	 * Check if at least one permission has r_encrypt set to true.
	 * We have to check specifics in the route handler to get the keyring name from fields.
	 */
	if (c.var.globalPermissions && c.var.globalPermissions.r_keyrings >= 2) {
		await next();
	} else {
		console.error("Token doesn't have permissions");
		return c.json({ success: false, errors: [{ message: 'Access Denied: You do not have permission to perform this action' }] }, 403);
	}
});

export const route = createRoute({
	tags: [APITags['Keyring Management']],
	method: 'post',
	path: '/',
	description: 'Create a new keyring.',
	request: {
		body: {
			content: {
				'application/json': {
					schema: keyringEditable,
				},
			},
		},
	},
	responses: {
		200: {
			content: {
				'application/json': {
					schema: keyringOutput,
				},
			},
			description: 'The new keyring created.',
		},
	},
});

app.openapi(route, (c) => {
	// Needs to be set to a variable or else type isn't inferred
	const json = c.req.valid('json');

	return BufferHelpers.generateUuid7().then(async (kr_id) =>
		c.var
			.t_db()
			.insert(keyrings)
			.values({
				kr_id: sql<Buffer>`unhex(${kr_id.hex})`,
				name: json.name,
				key_type: json.key.algorithm,
				// @ts-expect-error size does sometimes exist
				key_size: (json.key.size as number | undefined) ?? null,
				hash: json.key.hash as (typeof workersCryptoCatalog.hashes)[number],
				time_rotation: json.rotation.time.enabled,
				count_rotation: json.rotation.count.enabled ? sql<Buffer>`unhex(${await BufferHelpers.bigintToHex(BigInt(json.rotation.count.threshold))})` : null,
			})
			.returning({
				b_time: keyrings.b_time,
				c_time: keyrings.c_time,
				m_time: keyrings.m_time,
			})
			.then(async ([row]) => {
				if (row) {
					await c.env.DATA_KEY_ROTATION.create({
						params: {
							t_id: c.var.t_id.utf8,
							kr_id: kr_id.utf8,
						} satisfies z.infer<typeof workflowParams>,
					});

					return c.json({
						...json,
						created: row.b_time,
						lastModified: row.c_time,
						rotation: {
							...json.rotation,
							lastRotation: row.m_time,
							time: {
								...json.rotation.time,
								next:
									json.rotation.time.cron
										.map((cron) => parseCronExpression(cron).getNextDate())
										.sort((a, b) => a.getTime() - b.getTime())[0]
										?.toISOString() ?? null,
							},
							count: {
								...json.rotation.count,
								threshold: json.rotation.count.threshold.toString() as unknown as bigint,
								current: BigInt(0).toString() as unknown as bigint,
							},
						},
					} satisfies z.infer<typeof keyringOutput>);
				} else {
					c.json({ success: false });
				}
			})
			.catch(() => c.json({ success: false })),
	);
});

export default app;
