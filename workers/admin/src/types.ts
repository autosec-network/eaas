import type { DurableObject } from 'cloudflare:workers';
import type { SessionPropertiesSchema, TenantPropertiesSchema, UserPropertiesSchema } from 'db';
import type { UUID } from 'node:crypto';
import type { DOJurisdictions } from 'types';
import type { ProjectResponse, SecretResponse } from 'types/bw/schemas';
import type { ZodPick } from 'types/zod/mini';
import type * as zm from 'zod/mini';

export interface EnvVars extends Omit<Cloudflare.Env, 'BITWARDEN_SESSION_PROD' | 'TENANT_D0_PROD' | 'USER_D0_PROD' | 'USER_SESSION_PROD'>, TypedBindings {
	GIT_HASH?: string;
	CF_ACCOUNT_ID: string;
}

interface TypedBindings {
	// BITWARDEN_SESSION_DEV: DurableObjectNamespace<BitwardenSession>;
	BITWARDEN_SESSION_PROD: DurableObjectNamespace<BitwardenSession>;
	// TENANT_D0_DEV: DurableObjectNamespace<TenantD0>;
	TENANT_D0_PROD: DurableObjectNamespace<TenantD0>;
	// USER_D0_DEV: DurableObjectNamespace<UserD0>;
	USER_D0_PROD: DurableObjectNamespace<UserD0>;
	// USER_SESSION_DEV: DurableObjectNamespace<UserSession>;
	USER_SESSION_PROD: DurableObjectNamespace<UserSession>;
}

interface ProjectResponseEnhanced extends Omit<ProjectResponse, 'id'> {
	id: UUID;
	read: boolean;
	write: boolean;
}
interface SecretsProject {
	id: UUID;
	name: string;
}
declare class BitwardenSession extends DurableObject {
	public init(_options: { t_jurisdiction: DOJurisdictions | null; t_do_id: ArrayBuffer | null; endpoints: { base: string; authentication: string } }): Promise<void>;
	public auth(accessToken: string): Promise<void>;
	public getOrgEncryptionKey(accessToken: string): Promise<string>;
	public getProjects(): Promise<ProjectResponseEnhanced[]>;
	public getSecretsAndProjects(): Promise<{ projects: SecretsProject[]; secrets: { creationDate: string; id: UUID; key: string; organizationId: UUID; projects: SecretsProject[]; read: boolean; revisionDate: string; write: boolean }[] }>;
	public getSecrets(_secretIds: string[]): Promise<{ creationDate: string; id: UUID; key: string; note: string; object: string; organizationId: UUID; projects: SecretsProject[]; revisionDate: string; value: string }[]>;
	public setSecret(_options: { projectId: string; key: string; value: string; note?: string | undefined }): Promise<SecretResponse>;
	public decryptSecret(accessToken: string, cipherText: string): Promise<string>;
	public encryptSecret(accessToken: string, plainText: string, iv?: Buffer<ArrayBufferLike>, version?: 0 | 1 | 2): Promise<string>;
	public deleteSecrets(_secretIds: string[]): Promise<UUID[]>;
	public nuke(reason?: string, hard?: boolean): Promise<void>;
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

	public nuke(reason?: string, hard?: boolean): Promise<void>;
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

declare class UserSession extends DurableObject {
	public getProperties(_keys?: ZodPick<typeof SessionPropertiesSchema>, lazy?: boolean): Promise<Partial<zm.output<typeof SessionPropertiesSchema>>>;
	public getPropertiesSync(_keys?: ZodPick<typeof SessionPropertiesSchema>): Partial<zm.output<typeof SessionPropertiesSchema>>;
	public updateProperties(_properties: Partial<zm.input<typeof SessionPropertiesSchema>>, background?: boolean, lazy?: boolean): Promise<Partial<zm.output<typeof SessionPropertiesSchema>>>;
	public updatePropertiesSync(_properties: Partial<zm.input<typeof SessionPropertiesSchema>>, background?: boolean, lazy?: boolean): Partial<zm.output<typeof SessionPropertiesSchema>>;
	public nuke(reason?: string, hard?: boolean): Promise<void>;
}
