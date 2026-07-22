import type { DurableObject } from 'cloudflare:workers';
import type { SessionPropertiesSchema, TenantPropertiesSchema, UserPropertiesSchema } from 'db';
import type { Buffer } from 'node:buffer';
import type { UUID } from 'node:crypto';
import type { DOJurisdictions } from 'types';
import type { ProjectResponse, SecretResponse } from 'types/bw/schemas';
import type { ZodPick } from 'types/zod/mini';
import type * as zm from 'zod/mini';

export interface EnvVars extends TypedBindings {
	GIT_HASH?: string;
}

interface TypedBindings {
	BITWARDEN_SESSION: DurableObjectNamespace<BitwardenSession>;
	TENANT_D0: DurableObjectNamespace<TenantD0>;
	TENANT_D0_LOGS: DurableObjectNamespace<TenantD0Logs>;
	USER_D0: DurableObjectNamespace<UserD0>;
	USER_SESSION: DurableObjectNamespace<UserSession>;
}

/**
 * Hand-typed mirrors of the public method surface of the Durable Objects owned by `api` (`workers/api/do/*.ts`) and `customer` (`workers/customer/do/UserSession.ts`). This worker only ever binds to those classes cross-worker (via `script_name` in `wrangler.jsonc`), the same way `wrangler types` types any other cross-service Durable Object binding — these are just maintained by hand here instead of generated, since generation requires querying the live deployed workers. Keep in sync with the source DOs when their public methods change.
 */

interface ProjectResponseEnhanced extends Omit<ProjectResponse, 'id'> {
	id: UUID;
	read: boolean;
	write: boolean;
}

interface SecretsProject {
	id: UUID;
	name: string;
}

export declare class BitwardenSession extends DurableObject {
	init(_options: { t_jurisdiction: DOJurisdictions | null; t_do_id: ArrayBuffer | null; endpoints: { base: string; authentication: string } }): Promise<void>;
	auth(accessToken: string): Promise<void>;
	getOrgEncryptionKey(accessToken: string): Promise<string>;
	getProjects(): Promise<ProjectResponseEnhanced[]>;
	getSecretsAndProjects(): Promise<{ projects: SecretsProject[]; secrets: { creationDate: string; id: UUID; key: string; organizationId: UUID; projects: SecretsProject[]; read: boolean; revisionDate: string; write: boolean }[] }>;
	getSecrets(_secretIds: string[]): Promise<{ creationDate: string; id: UUID; key: string; note: string; object: string; organizationId: UUID; projects: SecretsProject[]; revisionDate: string; value: string }[]>;
	setSecret(_options: { projectId: string; key: string; value: string; note?: string }): Promise<SecretResponse>;
	decryptSecret(accessToken: string, cipherText: string, iv?: boolean): Promise<string | { data: string; iv: Buffer }>;
	encryptSecret(accessToken: string, plainText: string, iv?: Buffer, version?: 0 | 1 | 2): Promise<string>;
	deleteSecrets(_secretIds: string[]): Promise<UUID[]>;
	nuke(reason?: string, hard?: boolean): Promise<void>;
}

export declare class BaseD0 extends DurableObject {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	sqlExec(statements: { query: string; bindings?: any[] }[]): Promise<{ result: Record<string, unknown>[]; rowsRead: number; rowsWritten: number; duration: number }[]>;
	optimize(): Promise<unknown>;
	getBookmark(timestamp?: number | Date): Promise<string>;
	restoreToBookmark(bookmark: string): Promise<void>;
	nuke(reason?: string, hard?: boolean): Promise<void>;
}

interface ScheduleResult {
	id: UUID;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	payload: any[];
	next_time: Date;
	type: 'scheduled' | 'delayed' | 'cron';
}

interface ScheduleCriteria {
	// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
	id?: UUID | string;
	type?: 'scheduled' | 'delayed' | 'cron';
	timeRange?: { start?: Date; end?: Date };
}

export declare class TenantD0 extends BaseD0 {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	schedule(when: Date | number | string[], callee: string, payload?: any[], id?: UUID): Promise<ScheduleResult>;
	// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
	getSchedule(id: UUID | string): Promise<Record<string, unknown> | undefined>;
	getSchedules(criteria?: ScheduleCriteria): Promise<Record<string, unknown>[]>;
	// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
	cancelSchedule(id: UUID | string): Promise<void>;
	getProperties(_keys?: ZodPick<typeof TenantPropertiesSchema>, lazy?: boolean): Promise<Partial<zm.output<typeof TenantPropertiesSchema>>>;
	getPropertiesSync(_keys?: ZodPick<typeof TenantPropertiesSchema>): Partial<zm.output<typeof TenantPropertiesSchema>>;
	updateProperties(_properties: Partial<zm.input<typeof TenantPropertiesSchema>>, background?: boolean, lazy?: boolean): Promise<Partial<zm.output<typeof TenantPropertiesSchema>>>;
	updatePropertiesSync(_properties: Partial<zm.input<typeof TenantPropertiesSchema>>, background?: boolean, lazy?: boolean): Partial<zm.output<typeof TenantPropertiesSchema>>;
}

export declare class TenantD0Logs extends BaseD0 {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	schedule(when: Date | number | string[], callee: string, payload?: any[], id?: UUID): Promise<ScheduleResult>;
	// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
	getSchedule(id: UUID | string): Promise<Record<string, unknown> | undefined>;
	getSchedules(criteria?: ScheduleCriteria): Promise<Record<string, unknown>[]>;
	// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
	cancelSchedule(id: UUID | string): Promise<void>;
	_cleanupPendingWebsockets(): void;
	_optimizeDb(): void;
}

export declare class UserD0 extends BaseD0 {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	schedule(when: Date | number | string[], callee: string, payload?: any[], id?: UUID): Promise<ScheduleResult>;
	// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
	getSchedule(id: UUID | string): Promise<Record<string, unknown> | undefined>;
	getSchedules(criteria?: ScheduleCriteria): Promise<Record<string, unknown>[]>;
	// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
	cancelSchedule(id: UUID | string): Promise<void>;
	_cleanupVerificationTokens(): void;
	getProperties(_keys?: ZodPick<typeof UserPropertiesSchema>, lazy?: boolean): Promise<Partial<zm.output<typeof UserPropertiesSchema>>>;
	getPropertiesSync(_keys?: ZodPick<typeof UserPropertiesSchema>): Partial<zm.output<typeof UserPropertiesSchema>>;
	updateProperties(_properties: Partial<zm.input<typeof UserPropertiesSchema>>, background?: boolean, lazy?: boolean): Promise<Partial<zm.output<typeof UserPropertiesSchema>>>;
	updatePropertiesSync(_properties: Partial<zm.input<typeof UserPropertiesSchema>>, background?: boolean, lazy?: boolean): Partial<zm.output<typeof UserPropertiesSchema>>;
}

export declare class UserSession extends DurableObject {
	getProperties(_keys?: ZodPick<typeof SessionPropertiesSchema>, lazy?: boolean): Promise<Partial<zm.output<typeof SessionPropertiesSchema>>>;
	getPropertiesSync(_keys?: ZodPick<typeof SessionPropertiesSchema>): Partial<zm.output<typeof SessionPropertiesSchema>>;
	updateProperties(_properties: Partial<zm.input<typeof SessionPropertiesSchema>>, background?: boolean, lazy?: boolean): Promise<Partial<zm.output<typeof SessionPropertiesSchema>>>;
	updatePropertiesSync(_properties: Partial<zm.input<typeof SessionPropertiesSchema>>, background?: boolean, lazy?: boolean): Partial<zm.output<typeof SessionPropertiesSchema>>;
	nuke(reason?: string, hard?: boolean): Promise<void>;
}
