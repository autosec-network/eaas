import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import type { TimingVariables } from 'hono/timing';
import type { Buffer } from 'node:buffer';
import type { DOJurisdictions, Permissions } from 'types';
import type { TenantLogQueueMessageSchema } from 'types/tenants/logging';
import type * as zm from 'zod/mini';
import type { BitwardenSessionProxy, TenantD0LogsProxy, TenantD0Proxy, UserD0Proxy } from '../../do-proxy/src/index';

export interface EnvVars extends Omit<Cloudflare.Env, 'LOGS' | 'BITWARDEN_SESSION_PROXY' | 'TENANT_D0_PROXY' | 'TENANT_D0_LOGS_PROXY' | 'USER_D0_PROXY'>, TypedBindings {
	GIT_HASH?: string;
	CF_ACCOUNT_ID: string;
	EU_BW_SM_PROJECT_ID: string;
	US_BW_SM_PROJECT_ID: string;
}

interface TypedBindings {
	LOGS: Queue<zm.input<typeof TenantLogQueueMessageSchema>>;
	/**
	 * Local-dev-only proxy to this worker's own `BITWARDEN_SESSION`, only present in the `prod` deployment (see `workers/do-proxy`). Unused by live code.
	 */
	BITWARDEN_SESSION_PROXY?: Service<BitwardenSessionProxy>;
	/**
	 * Local-dev-only proxy to this worker's own `TENANT_D0`, only present in the `prod` deployment (see `workers/do-proxy`). Unused by live code.
	 */
	TENANT_D0_PROXY?: Service<TenantD0Proxy>;
	/**
	 * Local-dev-only proxy to this worker's own `TENANT_D0_LOGS`, only present in the `prod` deployment (see `workers/do-proxy`). Unused by live code.
	 */
	TENANT_D0_LOGS_PROXY?: Service<TenantD0LogsProxy>;
	/**
	 * Local-dev-only proxy to this worker's own `USER_D0`, only present in the `prod` deployment (see `workers/do-proxy`). Unused by live code.
	 */
	USER_D0_PROXY?: Service<UserD0Proxy>;
}

export interface BufferExport {
	buffer: Buffer;
	hex: string;
	base64: string;
	base64url: string;
}

export interface ContextVariables extends TimingVariables {
	browserCache: boolean;

	a_db: SqliteRemoteDatabase;
	r_db: DrizzleD1Database;

	t_id: BufferExport;
	t_do_id: string;
	t_jurisdiction: DOJurisdictions | null;
	t_db: SqliteRemoteDatabase;

	ak_id: BufferExport;
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
