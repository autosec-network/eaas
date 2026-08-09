import type { DurableObject } from 'cloudflare:workers';
import type { SessionPropertiesSchema, TenantPropertiesSchema, UserPropertiesSchema } from 'db';
import type { UUID } from 'node:crypto';
import type { DOJurisdictions } from 'types';
import type { ProjectResponse, SecretResponse } from 'types/bw/schemas';
import type { TenantLogQueueMessageSchema } from 'types/tenants/logging';
import type { ZodPick } from 'types/zod/mini';
import type * as zm from 'zod/mini';

export interface EnvVars extends Omit<Cloudflare.Env, 'LOGS_DEV' | 'LOGS_PROD' | 'BITWARDEN_SESSION_PROD' | 'TENANT_D0_PROD' | 'TENANT_D0_LOGS_PROD' | 'USER_D0_PROD' | 'USER_SESSION_PROD'>, TypedBindings {
	GIT_HASH?: string;
	CF_ACCOUNT_ID: string;
	EU_BW_SM_PROJECT_ID_PROD: string;
	EU_BW_SM_PROJECT_ID_DEV: string;
	US_BW_SM_PROJECT_ID_PROD: string;
	US_BW_SM_PROJECT_ID_DEV: string;
}

interface TypedBindings {
	/**
	 * Tenant audit logs. Unlike the other bindings both environments are always wired, since a queue exists independently of whichever worker consumes it — pick with the `[environment]` route param, the same way `DB_ROOT_*` is picked. Send `TenantLogQueueMessageSchema`-parsed messages; `api`'s queue consumer is the only writer.
	 */
	LOGS_DEV: Queue<zm.input<typeof TenantLogQueueMessageSchema>>;
	LOGS_PROD: Queue<zm.input<typeof TenantLogQueueMessageSchema>>;
	// BITWARDEN_SESSION_DEV: DurableObjectNamespace<BitwardenSession>;
	BITWARDEN_SESSION_PROD: DurableObjectNamespace<BitwardenSession>;
	// TENANT_D0_DEV: DurableObjectNamespace<TenantD0>;
	TENANT_D0_PROD: DurableObjectNamespace<TenantD0>;
	// TENANT_D0_LOGS_DEV: DurableObjectNamespace<BaseD0>;
	/** Only ever read/wiped through the generic `BaseD0` surface, so it needs no class of its own here */
	TENANT_D0_LOGS_PROD: DurableObjectNamespace<BaseD0>;
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
	public init(_options: { t_jurisdiction: DOJurisdictions | null; t_do_id: ArrayBuffer | null; t_id: string | null; u_id: string | null; ak_id: string | null; endpoints: { base: string; authentication: string } }): Promise<void>;
	public auth(accessToken: string): Promise<void>;
	public getOrgEncryptionKey(accessToken: string): Promise<string>;
	public getProjects(): Promise<ProjectResponseEnhanced[]>;
	public getSecretsAndProjects(): Promise<{ projects: SecretsProject[]; secrets: { creationDate: string; id: UUID; key: string; organizationId: UUID; projects: SecretsProject[]; read: boolean; revisionDate: string; write: boolean }[] }>;
	public getSecrets(_secretIds: string[]): Promise<{ creationDate: string; id: UUID; key: string; note: string; object: string; organizationId: UUID; projects: SecretsProject[]; revisionDate: string; value: string }[]>;
	public setSecret(_options: { projectId: string; key: string; value: string; note?: string | undefined }): Promise<SecretResponse>;
	public decryptSecret(accessToken: string, cipherText: string): Promise<string>;
	public encryptSecret(accessToken: string, plainText: string, iv?: Buffer<ArrayBufferLike>, version?: 0 | 1 | 2): Promise<string>;
	public deleteSecrets(_secretIds: string[]): Promise<UUID[]>;
	/**
	 * Rejects when this session can't take work - already at its concurrency cap, or no longer authenticated. See `acquireBitwardenSession` in `helpers/bitwarden-sessions`.
	 */
	public available(): Promise<{ expires: Date }>;
	public activeTasks(): { active: number; max: number };
	public nuke(reason?: string, hard?: boolean): Promise<void>;
}

/**
 * One row of a tenant's Bitwarden session pool, as `TenantD0.listBitwardenSessions` hands it back.
 */
export interface PooledBitwardenSession {
	do_id: string;
	fingerprint: string;
	expires: Date;
	b_time: Date;
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
	public registerBitwardenSession(_options: { do_id: string; fingerprint: string; expires: Date }): Promise<void>;
	public listBitwardenSessions(_options?: { fingerprint?: string; includeExpired?: boolean }): Promise<PooledBitwardenSession[]>;
	public unregisterBitwardenSession(do_id: string): Promise<void>;
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
