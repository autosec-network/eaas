import type { D1Database, D1Result, SqlStorage } from '@cloudflare/workers-types/experimental';
import type { BatchItem, BatchResponse } from 'drizzle-orm/batch';
import type { entityKind } from 'drizzle-orm/entity';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import type { SqliteRemoteResult } from 'drizzle-orm/sqlite-proxy';
import type { UuidExport } from '../types/d1/index.mjs';

export type FlexibleDbRef = D1Database | SqlStorage | ApiDbRef;
export interface ApiDbRef {
	accountId: string;
	apiToken: string;
	databaseId: UuidExport['utf8'];
}

export declare class DrizzleCommonDatabase<TSchema extends Record<string, unknown> = Record<string, never>> extends BaseSQLiteDatabase<'async', D1Result | SqliteRemoteResult, TSchema> {
	static readonly [entityKind]: string;
	batch<U extends BatchItem<'sqlite'>, T extends Readonly<[U, ...U[]]>>(batch: T): Promise<BatchResponse<T>>;
}

export interface CliArgs {
	type: ('root' | 'tenant')[];
}

export type CliWorkerData = CliWorkerDataGenerate | CliWorkerDataMigrate;
export interface CliWorkerDataGenerate {
	type: 'generate';
}
export interface CliWorkerDataMigrate {
	type: 'migrate';

	remote: boolean;
}

export interface CliWranglerConfig extends Record<string, any> {
	d1_databases: {
		binding: string;
		database_name: string;
		database_id: string;
		migrations_dir: string;
	}[];
}
