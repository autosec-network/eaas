import type * as rootSchema from 'db/schemas/root';
import type * as tenantSchema from 'db/schemas/tenant/main';
import type * as analyticsSchema from 'db/schemas/wae';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import type { TimingVariables } from 'hono/timing';
import type { Buffer } from 'node:buffer';
import type { DOJurisdictions, Permissions } from 'types';

export interface EnvVars extends Omit<Cloudflare.Env, ''>, TypedBindings {
	GIT_HASH?: string;
	CF_ACCOUNT_ID: string;
	EU_BW_SM_PROJECT_ID: string;
	US_BW_SM_PROJECT_ID: string;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface TypedBindings {}

export interface BufferExport {
	buffer: Buffer;
	hex: string;
	base64: string;
	base64url: string;
}

export interface ContextVariables extends TimingVariables {
	// cloneRawRequest(c.req)
	// bodyClone: ReturnType<Parameters<Exclude<WorkerEntrypoint['fetch'], undefined>>[0]['clone']>;
	browserCache: boolean;

	a_db: SqliteRemoteDatabase<typeof analyticsSchema>;
	r_db: DrizzleD1Database<typeof rootSchema>;

	t_id: BufferExport;
	t_do_id: string;
	t_jurisdiction: DOJurisdictions | null;
	t_db: SqliteRemoteDatabase<typeof tenantSchema>;

	ak_id: BufferExport;
	/** Active noise pipe ID from X-Noise-Pipe header */
	noisePipeId?: string;
	globalPermissions?: {
		/**
		 * 0. Can see all keyrings it has permission linked
		 * @note If key is expired, it will always return 0 regardless of actual permission
		 * 1. Can see all keyrings
		 * 2. Can create/edit keyrings
		 * 3. Can delete keyrings
		 */
		r_keyrings: Permissions;
		/**
		 * 0. Can see self api key
		 * @note If key is expired, it will always return 0 regardless of actual permission
		 * 1. Can see all apikeys
		 * 2. Can edit or rotate
		 * 3. Can create/delete apikeys
		 * @note Only rotate shows the actual (new) key
		 */
		r_apikeys: Permissions;
	};
	permissions: Record<
		BufferExport['base64url'],
		{
			kr_name: string;
			generation_versions: number;
			retreival_versions: number;
			/**
			 * 1. Can see all datakeys
			 * 2. Can rotate
			 * 3. Can prune/delete datakeys
			 * @note None show the actual key
			 */
			r_datakeys: Permissions;
			r_encrypt: boolean;
			r_decrypt: boolean;
			r_rewrap: boolean;
			r_sign: boolean;
			r_verify: boolean;
			r_hmac: boolean;
		}
	>;
}
