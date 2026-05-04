import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import * as analyticsSchema from 'db/schemas/wae';
import { max, sql } from 'drizzle-orm/sql';
import type { ContextVariables, EnvVars } from '~/types';
import { APITags } from '~/v0/extras';

const app = new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>();

export const route = createRoute({
	tags: [APITags.Stats],
	method: 'get',
	path: '/',
	security: [],
	description: 'Returns the top 20 browser-reported languages and their percentage share of visitor sessions. Each session is counted once to avoid inflating individual users, and results are weighted to account for adaptive sampling.',
	responses: {
		200: {
			content: {
				'application/json': {
					schema: z
						.array(
							z.object({
								language: z.string().trim().nonempty().toLowerCase().openapi({ example: 'en' }),
								trafficPercentage: z.number().min(0).max(100),
							}),
						)
						.min(1)
						.max(20),
				},
			},
			description: 'Languages sorted by share of sessions, from most to least common.',
		},
	},
});

app.openapi(route, async (c) => {
	// Deduplicate at SQL level - one row per session.
	// max(_sample_interval) is the sampling-aware weight per CF WAE sampling docs.
	// argMax(blobN, _sample_interval) picks a representative language value per session.
	const sessions = await c.var.a_db
		.select({
			si: max(analyticsSchema.EAAS_LANG_ANALYTICS._sample_interval).as('si'),
			l1: sql<string>`argMax(${analyticsSchema.EAAS_LANG_ANALYTICS.lang1}, ${analyticsSchema.EAAS_LANG_ANALYTICS._sample_interval})`.as('l1'),
			l2: sql<string>`argMax(${analyticsSchema.EAAS_LANG_ANALYTICS.lang2}, ${analyticsSchema.EAAS_LANG_ANALYTICS._sample_interval})`.as('l2'),
			l3: sql<string>`argMax(${analyticsSchema.EAAS_LANG_ANALYTICS.lang3}, ${analyticsSchema.EAAS_LANG_ANALYTICS._sample_interval})`.as('l3'),
			l4: sql<string>`argMax(${analyticsSchema.EAAS_LANG_ANALYTICS.lang4}, ${analyticsSchema.EAAS_LANG_ANALYTICS._sample_interval})`.as('l4'),
			l5: sql<string>`argMax(${analyticsSchema.EAAS_LANG_ANALYTICS.lang5}, ${analyticsSchema.EAAS_LANG_ANALYTICS._sample_interval})`.as('l5'),
			l6: sql<string>`argMax(${analyticsSchema.EAAS_LANG_ANALYTICS.lang6}, ${analyticsSchema.EAAS_LANG_ANALYTICS._sample_interval})`.as('l6'),
			l7: sql<string>`argMax(${analyticsSchema.EAAS_LANG_ANALYTICS.lang7}, ${analyticsSchema.EAAS_LANG_ANALYTICS._sample_interval})`.as('l7'),
			l8: sql<string>`argMax(${analyticsSchema.EAAS_LANG_ANALYTICS.lang8}, ${analyticsSchema.EAAS_LANG_ANALYTICS._sample_interval})`.as('l8'),
			l9: sql<string>`argMax(${analyticsSchema.EAAS_LANG_ANALYTICS.lang9}, ${analyticsSchema.EAAS_LANG_ANALYTICS._sample_interval})`.as('l9'),
			l10: sql<string>`argMax(${analyticsSchema.EAAS_LANG_ANALYTICS.lang10}, ${analyticsSchema.EAAS_LANG_ANALYTICS._sample_interval})`.as('l10'),
			l11: sql<string>`argMax(${analyticsSchema.EAAS_LANG_ANALYTICS.lang11}, ${analyticsSchema.EAAS_LANG_ANALYTICS._sample_interval})`.as('l11'),
			l12: sql<string>`argMax(${analyticsSchema.EAAS_LANG_ANALYTICS.lang12}, ${analyticsSchema.EAAS_LANG_ANALYTICS._sample_interval})`.as('l12'),
			l13: sql<string>`argMax(${analyticsSchema.EAAS_LANG_ANALYTICS.lang13}, ${analyticsSchema.EAAS_LANG_ANALYTICS._sample_interval})`.as('l13'),
			l14: sql<string>`argMax(${analyticsSchema.EAAS_LANG_ANALYTICS.lang14}, ${analyticsSchema.EAAS_LANG_ANALYTICS._sample_interval})`.as('l14'),
			l15: sql<string>`argMax(${analyticsSchema.EAAS_LANG_ANALYTICS.lang15}, ${analyticsSchema.EAAS_LANG_ANALYTICS._sample_interval})`.as('l15'),
			l16: sql<string>`argMax(${analyticsSchema.EAAS_LANG_ANALYTICS.lang16}, ${analyticsSchema.EAAS_LANG_ANALYTICS._sample_interval})`.as('l16'),
			l17: sql<string>`argMax(${analyticsSchema.EAAS_LANG_ANALYTICS.lang17}, ${analyticsSchema.EAAS_LANG_ANALYTICS._sample_interval})`.as('l17'),
			l18: sql<string>`argMax(${analyticsSchema.EAAS_LANG_ANALYTICS.lang18}, ${analyticsSchema.EAAS_LANG_ANALYTICS._sample_interval})`.as('l18'),
			l19: sql<string>`argMax(${analyticsSchema.EAAS_LANG_ANALYTICS.lang19}, ${analyticsSchema.EAAS_LANG_ANALYTICS._sample_interval})`.as('l19'),
			l20: sql<string>`argMax(${analyticsSchema.EAAS_LANG_ANALYTICS.lang20}, ${analyticsSchema.EAAS_LANG_ANALYTICS._sample_interval})`.as('l20'),
		})
		.from(analyticsSchema.EAAS_LANG_ANALYTICS)
		.groupBy(sql`index1`);

	// JS only handles the unavoidable columnar→row unpivot (WAE SQL has no UNION support).
	let totalWeight = 0;
	const langWeights = new Map<string, number>();

	for (const row of sessions) {
		const si = row.si ?? 1;
		totalWeight += si;
		for (const lang of [row.l1, row.l2, row.l3, row.l4, row.l5, row.l6, row.l7, row.l8, row.l9, row.l10, row.l11, row.l12, row.l13, row.l14, row.l15, row.l16, row.l17, row.l18, row.l19, row.l20]) {
			if (lang) langWeights.set(lang.toLowerCase(), (langWeights.get(lang.toLowerCase()) ?? 0) + si);
		}
	}

	return c.json(
		Array.from(langWeights.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, 20)
			.map(([language, weight]) => ({
				language,
				trafficPercentage: totalWeight > 0 ? Math.round((weight / totalWeight) * 10000) / 100 : 0,
			})),
		200,
	);
});

export default app;
