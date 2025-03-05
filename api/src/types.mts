import type { WorkerEntrypoint } from 'cloudflare:workers';
import type { TimingVariables } from 'hono/timing';
import type { DBManager } from '~shared/db-core/db.mjs';
import type { Permissions, UuidExport } from '~shared/types/d1/index.mjs';

export interface EnvVars extends Secrets, Bindings, VipBindingsProd, VipBindingsPreview, Record<string, any> {
	CF_ACCOUNT_ID: string;
	GIT_HASH: string;
	ENVIRONMENT: 'production' | 'preview';
	NODE_ENV: 'production' | 'development';
}

interface Secrets {
	CF_API_TOKEN: string;
	US_BW_SM_ACCESS_TOKEN: string;
}

interface Bindings {
	CF_VERSION_METADATA: WorkerVersionMetadata;
	EAAS_ROOT: D1Database;
}

interface VipBindingsProd {}

interface VipBindingsPreview {
	// Sushidata
	'98573F5FF41FFAEDCC34D6E8A143276A527827F519D617E511C55681C1BB4DED': D1Database;
}

export interface ContextVariables extends TimingVariables {
	bodyClone: ReturnType<Parameters<Exclude<WorkerEntrypoint['fetch'], undefined>>[0]['clone']>;
	r_db: ReturnType<typeof DBManager.getDrizzle>;

	t_id: UuidExport;
	t_d1_id: UuidExport;
	t_db: ReturnType<typeof DBManager.getDrizzle>;

	globalPermissions: {
		/**
		 * 0. Can see all keyrings it has permission linked
		 * 1. Can see all keyrings
		 * 2. Can create/edit keyrings
		 * 3. Can delete keyrings
		 */
		r_keyrings: Permissions;
		/**
		 * 0. Can see self api key
		 * 1. Can see all apikeys
		 * 2. Can edit or rotate
		 * 3. Can delete apikeys
		 * @note Only rotate shows the actual (new) key
		 */
		r_apikeys: Permissions;
	};
	permissions: Record<
		UuidExport['base64url'],
		{
			kr_name: string;
			generation_versions: number;
			retreival_versions: number;
			/**
			 * 1. Can see all datakeys
			 * 2. Can rotate
			 * 3. Can prune datakeys
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
