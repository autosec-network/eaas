import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import * as analyticsSchema from 'db/schemas/wae';
import { desc, gt, sql } from 'drizzle-orm/sql';
import { cache } from 'hono/cache';
import * as allAirports from 'iata-location/data';
import { AnalyticsSize } from 'types';
import type { Airport, ContextVariables, EnvVars } from '~/types';
import { APITags } from '~/v0/extras';

const app = new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>();

type Granularity = 'minute' | 'hour' | 'day' | 'week';

// `windowMs` is how far back each endpoint looks; `alignMs` is the clock boundary its cache TTL rounds up to.
const GRANULARITY: Record<Granularity, { windowMs: number; alignMs: number; label: string }> = {
	minute: { windowMs: 60 * 1_000, alignMs: 60 * 1_000, label: 'minute' },
	hour: { windowMs: 60 * 60 * 1_000, alignMs: 5 * 60 * 1_000, label: 'hour' },
	day: { windowMs: 24 * 60 * 60 * 1_000, alignMs: 60 * 60 * 1_000, label: 'day' },
	week: { windowMs: 7 * 24 * 60 * 60 * 1_000, alignMs: 24 * 60 * 60 * 1_000, label: 'week' },
};

app.use('/minute' satisfies `/${Granularity}`, (c, next) => {
	const now = c.var.requestDateTime.getTime();
	const nextBoundary = Math.ceil(now / GRANULARITY.minute.alignMs) * GRANULARITY.minute.alignMs;
	const ttlSeconds = Math.max(1, Math.ceil((nextBoundary - now) / 1000));

	return cache({
		cacheName: 'platform-stats',
		cacheControl: ['public', `max-age=${ttlSeconds}`, `s-maxage=${ttlSeconds}`, `stale-while-revalidate=${ttlSeconds}`].join(', '),
	})(
		// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
		c,
		next,
	);
});
app.use('/hour' satisfies `/${Granularity}`, (c, next) => {
	const now = c.var.requestDateTime.getTime();
	const nextBoundary = Math.ceil(now / GRANULARITY.hour.alignMs) * GRANULARITY.hour.alignMs;
	const ttlSeconds = Math.max(1, Math.ceil((nextBoundary - now) / 1000));

	return cache({
		cacheName: 'platform-stats',
		cacheControl: ['public', `max-age=${ttlSeconds}`, `s-maxage=${ttlSeconds}`, `stale-while-revalidate=${ttlSeconds}`].join(', '),
	})(
		// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
		c,
		next,
	);
});
app.use('/day' satisfies `/${Granularity}`, (c, next) => {
	const now = c.var.requestDateTime.getTime();
	const nextBoundary = Math.ceil(now / GRANULARITY.day.alignMs) * GRANULARITY.day.alignMs;
	const ttlSeconds = Math.max(1, Math.ceil((nextBoundary - now) / 1000));

	return cache({
		cacheName: 'platform-stats',
		cacheControl: ['public', `max-age=${ttlSeconds}`, `s-maxage=${ttlSeconds}`, `stale-while-revalidate=${ttlSeconds}`].join(', '),
	})(
		// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
		c,
		next,
	);
});
app.use('/week' satisfies `/${Granularity}`, (c, next) => {
	const now = c.var.requestDateTime.getTime();
	const nextBoundary = Math.ceil(now / GRANULARITY.week.alignMs) * GRANULARITY.week.alignMs;
	const ttlSeconds = Math.max(1, Math.ceil((nextBoundary - now) / 1000));

	return cache({
		cacheName: 'platform-stats',
		cacheControl: ['public', `max-age=${ttlSeconds}`, `s-maxage=${ttlSeconds}`, `stale-while-revalidate=${ttlSeconds}`].join(', '),
	})(
		// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
		c,
		next,
	);
});

// Kept at module scope rather than inlined at its one call site: constructing an Intl.DisplayNames is too costly to redo per row.
const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });
const latLongRegex = /^([-+]?\d+(\.\d+)?)$/i;

type OperationCounts = Record<(typeof analyticsSchema.EAAS_PLATFORM_ANALYTICS.operation.enumValues)[number], number>;
const exampleIata = (allAirports as Record<keyof typeof allAirports, Airport>).SFO;

app.openapi(
	createRoute({
		tags: [APITags.Stats],
		method: 'get',
		path: '/minute' satisfies `/${Granularity}`,
		security: [],
		description: `Raw feed of individual crypto operations, newest first, over the last ${'minute' satisfies Granularity}.`,
		responses: {
			200: {
				content: {
					'application/json': {
						schema: z
							.array(
								z.object({
									timestamp: z.iso.datetime({ precision: 0 }).openapi({ example: new Date(0).toISOString() }),
									operation: z.enum([...analyticsSchema.EAAS_PLATFORM_ANALYTICS.operation.enumValues]),
									algorithm: z.string().trim().nonempty().nullable().openapi({ example: 'AES-GCM' }),
									iata: z.string().trim().length(3).toUpperCase().openapi({ example: exampleIata.iata_code }),
									latitude: z.string().trim().nonempty().regex(latLongRegex).openapi({ example: exampleIata.latitude_deg }),
									longitude: z.string().trim().nonempty().regex(latLongRegex).openapi({ example: exampleIata.longitude_deg }),
									location: z
										.string()
										.trim()
										.nonempty()
										.openapi({
											example: [exampleIata.municipality, exampleIata.iso_region.startsWith(`${exampleIata.iso_country}-`) ? exampleIata.iso_region.slice(exampleIata.iso_country.length + 1) : null, exampleIata.iso_country].filter(Boolean).join(', '),
										}),
									size: z.enum(Object.values(AnalyticsSize).filter((val) => typeof val === 'string') as (keyof typeof AnalyticsSize)[]).openapi({ example: AnalyticsSize[2] }),
									count: z.number().nonnegative(),
								}),
							)
							.max(60 * 1_000),
					},
				},
				description: 'Individual operations, newest first, one line per WAE data point (already collapsed by the writer - see `count`).',
			},
		},
	}),
	async (c) => {
		// Aligned to the same clock boundary the cache middleware above rounds its TTL to, so the window this query covers doesn't drift within one cache lifetime.
		const boundary = Math.floor(c.var.requestDateTime.getTime() / GRANULARITY.minute.alignMs) * GRANULARITY.minute.alignMs;
		const cutoff = new Date(boundary - GRANULARITY.minute.windowMs).toISOString().slice(0, 19).replace('T', ' ') as `${number}-${number}-${number} ${number}:${number}:${number}`;

		const rows = await c.var.a_db
			.select({
				timestamp: analyticsSchema.EAAS_PLATFORM_ANALYTICS.timestamp,
				operation: analyticsSchema.EAAS_PLATFORM_ANALYTICS.operation,
				algorithm: analyticsSchema.EAAS_PLATFORM_ANALYTICS.algorithm,
				iata: analyticsSchema.EAAS_PLATFORM_ANALYTICS.iata,
				size: analyticsSchema.EAAS_PLATFORM_ANALYTICS.size,
				// _sample_interval is WAE's adaptive-sampling weight; count is the pre-aggregated event count the writer collapsed into this point.
				count: sql<number>`${analyticsSchema.EAAS_PLATFORM_ANALYTICS.count} * ${analyticsSchema.EAAS_PLATFORM_ANALYTICS._sample_interval}`.as('count'),
			})
			.from(analyticsSchema.EAAS_PLATFORM_ANALYTICS)
			.where(gt(analyticsSchema.EAAS_PLATFORM_ANALYTICS.timestamp, cutoff))
			.orderBy(desc(analyticsSchema.EAAS_PLATFORM_ANALYTICS.timestamp))
			.limit(60 * 1_000);

		return c.json(
			rows
				// '' is the column default for a redacted/missing PoP, and a PoP not in the `iata-location` dataset can't be plotted either - nothing to show a ticker line for.
				.filter((row) => row.iata in allAirports)
				.map((row) => {
					const airport = (allAirports as Record<keyof typeof allAirports, Airport>)[row.iata as keyof typeof allAirports];
					const region = airport.iso_region.startsWith(`${airport.iso_country}-`) ? airport.iso_region.slice(airport.iso_country.length + 1) : null;

					return {
						// WAE always populates timestamp; the column's `text()` type is just nullable because Drizzle has no way to say "system column".
						timestamp: `${row.timestamp!.replace(' ', 'T')}Z`,
						operation: row.operation,
						algorithm: row.algorithm || null,
						iata: row.iata,
						latitude: airport.latitude_deg,
						longitude: airport.longitude_deg,
						location: [airport.municipality, region, countryNames.of(airport.iso_country) ?? airport.iso_country].filter(Boolean).join(', '),
						// TS types numeric-enum reverse mapping as plain `string`; the runtime value is always one of the enum's own labels.
						size: AnalyticsSize[row.size] as keyof typeof AnalyticsSize,
						count: row.count,
					};
				}),
			200,
		);
	},
);
app.openapi(
	createRoute({
		tags: [APITags.Stats],
		method: 'get',
		path: '/hour' satisfies `/${Granularity}`,
		security: [],
		description: `Crypto operation volume per Cloudflare PoP over the last ${'hour' satisfies Granularity}. All timestamps are GMT.`,
		responses: {
			200: {
				content: {
					'application/json': {
						schema: z.record(
							z.string().trim().length(3).toUpperCase().openapi({ example: exampleIata.iata_code }),
							z.object({
								latitude: z.string().trim().nonempty().regex(latLongRegex).openapi({ example: exampleIata.latitude_deg }),
								longitude: z.string().trim().nonempty().regex(latLongRegex).openapi({ example: exampleIata.longitude_deg }),
								location: z
									.string()
									.trim()
									.nonempty()
									.openapi({
										example: [exampleIata.municipality, exampleIata.iso_region.startsWith(`${exampleIata.iso_country}-`) ? exampleIata.iso_region.slice(exampleIata.iso_country.length + 1) : null, exampleIata.iso_country].filter(Boolean).join(', '),
									}),
								operations: z.record(z.enum([...analyticsSchema.EAAS_PLATFORM_ANALYTICS.operation.enumValues]), z.int().nonnegative()),
							}),
						),
					},
				},
				description: 'Total operations over the window, keyed by PoP and broken down by operation type.',
			},
		},
	}),
	async (c) => {
		const boundary = Math.floor(c.var.requestDateTime.getTime() / GRANULARITY.hour.alignMs) * GRANULARITY.hour.alignMs;
		const cutoff = new Date(boundary - GRANULARITY.hour.windowMs).toISOString().slice(0, 19).replace('T', ' ') as `${number}-${number}-${number} ${number}:${number}:${number}`;

		const rows = await c.var.a_db
			.select({
				iata: analyticsSchema.EAAS_PLATFORM_ANALYTICS.iata,
				operation: analyticsSchema.EAAS_PLATFORM_ANALYTICS.operation,
				// _sample_interval is WAE's adaptive-sampling weight; count is the pre-aggregated event count the writer collapsed into this point.
				weighted: sql<number>`sum(${analyticsSchema.EAAS_PLATFORM_ANALYTICS.count} * ${analyticsSchema.EAAS_PLATFORM_ANALYTICS._sample_interval})`.as('weighted'),
			})
			.from(analyticsSchema.EAAS_PLATFORM_ANALYTICS)
			.where(gt(analyticsSchema.EAAS_PLATFORM_ANALYTICS.timestamp, cutoff))
			.groupBy(analyticsSchema.EAAS_PLATFORM_ANALYTICS.iata, analyticsSchema.EAAS_PLATFORM_ANALYTICS.operation);

		// JS only handles the unavoidable per-(iata,operation) pivot (WAE SQL has no pivot/UNION support).
		const byIata = new Map<string, OperationCounts>();
		for (const row of rows) {
			// '' is the column default for a redacted/missing PoP - nothing to plot it against.
			if (!row.iata) continue;

			const operations = byIata.get(row.iata) ?? (Object.fromEntries(analyticsSchema.EAAS_PLATFORM_ANALYTICS.operation.enumValues.map((op) => [op, 0])) as OperationCounts);
			operations[row.operation] += row.weighted;
			byIata.set(row.iata, operations);
		}

		return c.json(
			Object.fromEntries(
				Array.from(byIata.entries())
					// A PoP not in the `iata-location` dataset can't be plotted either - nothing to key a breakdown by.
					.filter(([iata]) => iata in allAirports)
					.map(([iata, operations]) => {
						const airport = (allAirports as Record<keyof typeof allAirports, Airport>)[iata as keyof typeof allAirports];
						const region = airport.iso_region.startsWith(`${airport.iso_country}-`) ? airport.iso_region.slice(airport.iso_country.length + 1) : null;

						return [
							iata,
							{
								latitude: airport.latitude_deg,
								longitude: airport.longitude_deg,
								location: [airport.municipality, region, countryNames.of(airport.iso_country) ?? airport.iso_country].filter(Boolean).join(', '),
								operations,
							},
						] as const;
					}),
			),
			200,
		);
	},
);
app.openapi(
	createRoute({
		tags: [APITags.Stats],
		method: 'get',
		path: '/day' satisfies `/${Granularity}`,
		security: [],
		description: `Crypto operation volume per Cloudflare PoP over the last ${'day' satisfies Granularity}. All timestamps are GMT.`,
		responses: {
			200: {
				content: {
					'application/json': {
						schema: z.record(
							z.string().trim().length(3).toUpperCase().openapi({ example: exampleIata.iata_code }),
							z.object({
								latitude: z.string().trim().nonempty().regex(latLongRegex).openapi({ example: exampleIata.latitude_deg }),
								longitude: z.string().trim().nonempty().regex(latLongRegex).openapi({ example: exampleIata.longitude_deg }),
								location: z
									.string()
									.trim()
									.nonempty()
									.openapi({
										example: [exampleIata.municipality, exampleIata.iso_region.startsWith(`${exampleIata.iso_country}-`) ? exampleIata.iso_region.slice(exampleIata.iso_country.length + 1) : null, exampleIata.iso_country].filter(Boolean).join(', '),
									}),
								operations: z.record(z.enum([...analyticsSchema.EAAS_PLATFORM_ANALYTICS.operation.enumValues]), z.int().nonnegative()),
							}),
						),
					},
				},
				description: 'Total operations over the window, keyed by PoP and broken down by operation type.',
			},
		},
	}),
	async (c) => {
		const boundary = Math.floor(c.var.requestDateTime.getTime() / GRANULARITY.day.alignMs) * GRANULARITY.day.alignMs;
		const cutoff = new Date(boundary - GRANULARITY.day.windowMs).toISOString().slice(0, 19).replace('T', ' ') as `${number}-${number}-${number} ${number}:${number}:${number}`;

		const rows = await c.var.a_db
			.select({
				iata: analyticsSchema.EAAS_PLATFORM_ANALYTICS.iata,
				operation: analyticsSchema.EAAS_PLATFORM_ANALYTICS.operation,
				// _sample_interval is WAE's adaptive-sampling weight; count is the pre-aggregated event count the writer collapsed into this point.
				weighted: sql<number>`sum(${analyticsSchema.EAAS_PLATFORM_ANALYTICS.count} * ${analyticsSchema.EAAS_PLATFORM_ANALYTICS._sample_interval})`.as('weighted'),
			})
			.from(analyticsSchema.EAAS_PLATFORM_ANALYTICS)
			.where(gt(analyticsSchema.EAAS_PLATFORM_ANALYTICS.timestamp, cutoff))
			.groupBy(analyticsSchema.EAAS_PLATFORM_ANALYTICS.iata, analyticsSchema.EAAS_PLATFORM_ANALYTICS.operation);

		// JS only handles the unavoidable per-(iata,operation) pivot (WAE SQL has no pivot/UNION support).
		const byIata = new Map<string, OperationCounts>();
		for (const row of rows) {
			// '' is the column default for a redacted/missing PoP - nothing to plot it against.
			if (!row.iata) continue;

			const operations = byIata.get(row.iata) ?? (Object.fromEntries(analyticsSchema.EAAS_PLATFORM_ANALYTICS.operation.enumValues.map((op) => [op, 0])) as OperationCounts);
			operations[row.operation] += row.weighted;
			byIata.set(row.iata, operations);
		}

		return c.json(
			Object.fromEntries(
				Array.from(byIata.entries())
					// A PoP not in the `iata-location` dataset can't be plotted either - nothing to key a breakdown by.
					.filter(([iata]) => iata in allAirports)
					.map(([iata, operations]) => {
						const airport = (allAirports as Record<keyof typeof allAirports, Airport>)[iata as keyof typeof allAirports];
						const region = airport.iso_region.startsWith(`${airport.iso_country}-`) ? airport.iso_region.slice(airport.iso_country.length + 1) : null;

						return [
							iata,
							{
								latitude: airport.latitude_deg,
								longitude: airport.longitude_deg,
								location: [airport.municipality, region, countryNames.of(airport.iso_country) ?? airport.iso_country].filter(Boolean).join(', '),
								operations,
							},
						] as const;
					}),
			),
			200,
		);
	},
);
app.openapi(
	createRoute({
		tags: [APITags.Stats],
		method: 'get',
		path: '/week' satisfies `/${Granularity}`,
		security: [],
		description: `Crypto operation volume per Cloudflare PoP over the last ${'week' satisfies Granularity}. All timestamps are GMT.`,
		responses: {
			200: {
				content: {
					'application/json': {
						schema: z.record(
							z.string().trim().length(3).toUpperCase().openapi({ example: exampleIata.iata_code }),
							z.object({
								latitude: z.string().trim().nonempty().regex(latLongRegex).openapi({ example: exampleIata.latitude_deg }),
								longitude: z.string().trim().nonempty().regex(latLongRegex).openapi({ example: exampleIata.longitude_deg }),
								location: z
									.string()
									.trim()
									.nonempty()
									.openapi({
										example: [exampleIata.municipality, exampleIata.iso_region.startsWith(`${exampleIata.iso_country}-`) ? exampleIata.iso_region.slice(exampleIata.iso_country.length + 1) : null, exampleIata.iso_country].filter(Boolean).join(', '),
									}),
								operations: z.record(z.enum([...analyticsSchema.EAAS_PLATFORM_ANALYTICS.operation.enumValues]), z.int().nonnegative()),
							}),
						),
					},
				},
				description: 'Total operations over the window, keyed by PoP and broken down by operation type.',
			},
		},
	}),
	async (c) => {
		const boundary = Math.floor(c.var.requestDateTime.getTime() / GRANULARITY.week.alignMs) * GRANULARITY.week.alignMs;
		const cutoff = new Date(boundary - GRANULARITY.week.windowMs).toISOString().slice(0, 19).replace('T', ' ') as `${number}-${number}-${number} ${number}:${number}:${number}`;

		const rows = await c.var.a_db
			.select({
				iata: analyticsSchema.EAAS_PLATFORM_ANALYTICS.iata,
				operation: analyticsSchema.EAAS_PLATFORM_ANALYTICS.operation,
				// _sample_interval is WAE's adaptive-sampling weight; count is the pre-aggregated event count the writer collapsed into this point.
				weighted: sql<number>`sum(${analyticsSchema.EAAS_PLATFORM_ANALYTICS.count} * ${analyticsSchema.EAAS_PLATFORM_ANALYTICS._sample_interval})`.as('weighted'),
			})
			.from(analyticsSchema.EAAS_PLATFORM_ANALYTICS)
			.where(gt(analyticsSchema.EAAS_PLATFORM_ANALYTICS.timestamp, cutoff))
			.groupBy(analyticsSchema.EAAS_PLATFORM_ANALYTICS.iata, analyticsSchema.EAAS_PLATFORM_ANALYTICS.operation);

		// JS only handles the unavoidable per-(iata,operation) pivot (WAE SQL has no pivot/UNION support).
		const byIata = new Map<string, OperationCounts>();
		for (const row of rows) {
			// '' is the column default for a redacted/missing PoP - nothing to plot it against.
			if (!row.iata) continue;

			const operations = byIata.get(row.iata) ?? (Object.fromEntries(analyticsSchema.EAAS_PLATFORM_ANALYTICS.operation.enumValues.map((op) => [op, 0])) as OperationCounts);
			operations[row.operation] += row.weighted;
			byIata.set(row.iata, operations);
		}

		return c.json(
			Object.fromEntries(
				Array.from(byIata.entries())
					// A PoP not in the `iata-location` dataset can't be plotted either - nothing to key a breakdown by.
					.filter(([iata]) => iata in allAirports)
					.map(([iata, operations]) => {
						const airport = (allAirports as Record<keyof typeof allAirports, Airport>)[iata as keyof typeof allAirports];
						const region = airport.iso_region.startsWith(`${airport.iso_country}-`) ? airport.iso_region.slice(airport.iso_country.length + 1) : null;

						return [
							iata,
							{
								latitude: airport.latitude_deg,
								longitude: airport.longitude_deg,
								location: [airport.municipality, region, countryNames.of(airport.iso_country) ?? airport.iso_country].filter(Boolean).join(', '),
								operations,
							},
						] as const;
					}),
			),
			200,
		);
	},
);

export default app;
