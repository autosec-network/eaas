export interface EnvVars extends Secrets, Bindings, Record<string, any> {
	CF_ACCOUNT_ID: string;
	GIT_HASH: string;
	ENVIRONMENT: 'production' | 'preview';
	NODE_ENV: 'production' | 'development';
}

interface Secrets {
	CF_API_TOKEN: string;
	US_BW_SM_ACCESS_TOKEN: string;
}

interface Bindings {}
