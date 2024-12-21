import type { WorkerEntrypoint } from 'cloudflare:workers';
import type { TimingVariables } from 'hono/timing';
import type { DBManager } from '~shared/db-core/db.mjs';
import type { UuidExport } from '~shared/types/d1/index.mjs';

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

	permissions: Record<
		UuidExport['base64url'],
		{
			kr_name: string;
			r_encrypt: boolean;
			r_decrypt: boolean;
			r_rewrap: boolean;
			r_sign: boolean;
			r_verify: boolean;
			r_hmac: boolean;
			r_random: boolean;
			r_hash: boolean;
		}
	>;
}
