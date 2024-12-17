import type { TimingVariables } from 'hono/timing';

export interface EnvVars extends Secrets, Bindings, Record<string, any> {
	CF_ACCOUNT_ID: string;
	GIT_HASH: string;
	ENVIRONMENT: 'production' | 'preview';
	NODE_ENV: 'production' | 'development';
}

interface Secrets {
	CF_API_TOKEN: string;
	BW_SM_ACCESS_TOKEN: string;
}

interface Bindings {
	CF_VERSION_METADATA: WorkerVersionMetadata;
	EAAS_ROOT: D1Database;
}

export interface ContextVariables extends TimingVariables {
	permissions: {
		r_encrypt: boolean;
		r_decrypt: boolean;
		r_rewrap: boolean;
		r_sign: boolean;
		r_verify: boolean;
		r_hmac: boolean;
		r_random: boolean;
		r_hash: boolean;
	};
}
