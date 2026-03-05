import type { DurableObject } from 'cloudflare:workers';
import type { TenantPropertiesSchema, UserPropertiesSchema } from 'db';
import type { ZodPick } from 'types/zod/mini';
import type * as zm from 'zod/mini';

export interface EnvVars extends Omit<Cloudflare.Env, 'TENANT_D0_PROD' | 'USER_D0_PROD'>, TypedBindings {
	GIT_HASH?: string;
	CF_ACCOUNT_ID: string;
}

interface TypedBindings {
	// TENANT_D0_DEV: DurableObjectNamespace<TenantD0>;
	// USER_D0_DEV: DurableObjectNamespace<UserD0>;
	TENANT_D0_PROD: DurableObjectNamespace<TenantD0>;
	USER_D0_PROD: DurableObjectNamespace<UserD0>;
}

declare class BaseD0 extends DurableObject {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	public sqlExec(statements: { query: string; bindings?: any[] | undefined }[]): Promise<
		{
			result: Record<string, SqlStorageValue>[];
			rowsRead: number;
			rowsWritten: number;
			duration: number;
			size: number;
		}[]
	>;

	public nuke(reason?: string): Promise<void>;
}

declare class TenantD0 extends BaseD0 {
	public getProperties(_keys?: ZodPick<typeof TenantPropertiesSchema>, lazy?: boolean): Promise<Partial<zm.output<typeof TenantPropertiesSchema>>>;
	public getPropertiesSync(_keys?: ZodPick<typeof TenantPropertiesSchema>): Partial<zm.output<typeof TenantPropertiesSchema>>;
	public updateProperties(_properties: Partial<zm.input<typeof TenantPropertiesSchema>>, background?: boolean, lazy?: boolean): Promise<Partial<zm.output<typeof TenantPropertiesSchema>>>;
	public updatePropertiesSync(_properties: Partial<zm.input<typeof TenantPropertiesSchema>>, background?: boolean, lazy?: boolean): Partial<zm.output<typeof TenantPropertiesSchema>>;
}
declare class UserD0 extends BaseD0 {
	public getProperties(_keys?: ZodPick<typeof UserPropertiesSchema>, lazy?: boolean): Promise<Partial<zm.output<typeof UserPropertiesSchema>>>;
	public getPropertiesSync(_keys?: ZodPick<typeof UserPropertiesSchema>): Partial<zm.output<typeof UserPropertiesSchema>>;
	public updateProperties(_properties: Partial<zm.input<typeof UserPropertiesSchema>>, background?: boolean, lazy?: boolean): Promise<Partial<zm.output<typeof UserPropertiesSchema>>>;
	public updatePropertiesSync(_properties: Partial<zm.input<typeof UserPropertiesSchema>>, background?: boolean, lazy?: boolean): Partial<zm.output<typeof UserPropertiesSchema>>;
}
