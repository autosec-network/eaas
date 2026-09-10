import { sqliteTable } from 'drizzle-orm/sqlite-core';
import type { AnalyticsSize } from 'types';
import { workersCryptoCatalog } from 'types/crypto/catalog';

export const EAAS_LANG_ANALYTICS = sqliteTable('EAAS_LANG_ANALYTICS', (ela) => ({
	dataset: ela.text({ enum: ['EAAS_LANG_ANALYTICS'] }),
	_sample_interval: ela.integer({ mode: 'number' }),
	timestamp: ela.text({ mode: 'text', length: 19 }),
	hashed_session_id: ela.text('index1', { mode: 'text' }).notNull(),
	lang1: ela.text('blob1', { mode: 'text' }).notNull().default(''),
	lang2: ela.text('blob2', { mode: 'text' }).notNull().default(''),
	lang3: ela.text('blob3', { mode: 'text' }).notNull().default(''),
	lang4: ela.text('blob4', { mode: 'text' }).notNull().default(''),
	lang5: ela.text('blob5', { mode: 'text' }).notNull().default(''),
	lang6: ela.text('blob6', { mode: 'text' }).notNull().default(''),
	lang7: ela.text('blob7', { mode: 'text' }).notNull().default(''),
	lang8: ela.text('blob8', { mode: 'text' }).notNull().default(''),
	lang9: ela.text('blob9', { mode: 'text' }).notNull().default(''),
	lang10: ela.text('blob10', { mode: 'text' }).notNull().default(''),
	lang11: ela.text('blob11', { mode: 'text' }).notNull().default(''),
	lang12: ela.text('blob12', { mode: 'text' }).notNull().default(''),
	lang13: ela.text('blob13', { mode: 'text' }).notNull().default(''),
	lang14: ela.text('blob14', { mode: 'text' }).notNull().default(''),
	lang15: ela.text('blob15', { mode: 'text' }).notNull().default(''),
	lang16: ela.text('blob16', { mode: 'text' }).notNull().default(''),
	lang17: ela.text('blob17', { mode: 'text' }).notNull().default(''),
	lang18: ela.text('blob18', { mode: 'text' }).notNull().default(''),
	lang19: ela.text('blob19', { mode: 'text' }).notNull().default(''),
	lang20: ela.text('blob20', { mode: 'text' }).notNull().default(''),
}));

export const EAAS_PLATFORM_ANALYTICS = sqliteTable('EAAS_PLATFORM_ANALYTICS', (epa) => ({
	dataset: epa.text({ enum: ['EAAS_PLATFORM_ANALYTICS'] }),
	_sample_interval: epa.integer({ mode: 'number' }),
	timestamp: epa.text({ mode: 'text', length: 19 }),
	/**
	 * Rewrap counts as 1 encrypt AND 1 decrypt
	 */
	operation: epa.text('index1', { enum: ['encrypt', 'decrypt', 'sign', 'verify', 'hmac', 'hash', 'random'] }).notNull(),
	algorithm: epa
		.text('blob1', { enum: ['', ...workersCryptoCatalog.ciphers, ...workersCryptoCatalog.curves, ...workersCryptoCatalog.hashes] })
		.notNull()
		.default(''),
	iata: epa.text('blob2', { mode: 'text' }).notNull().default(''),
	/**
	 * Size is rounded for privacy reasons. Value: Previous bucket > (plaintext content) <= specified bucket.
	 * If multiple collapsed, all in this point are of the same size (different size will trigger a different point).
	 * @example `2`: 1Kib > (plaintext content) ≤ 4KiB
	 */
	size: epa.real('double1').notNull().default(0).$type<AnalyticsSize>(),
	/**
	 * Number of events collapsed into this point.
	 * Cost saving: 10M data points/month included, $0.25/M after. One point per op at 100 ops/sec (max_batch_size) is 262.8M points/month ~$63.2/mo. At 1,000 ops/sec it's ~$654.5/mo
	 */
	count: epa.real('double2').notNull().default(0),
}));
