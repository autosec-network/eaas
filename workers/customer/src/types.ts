import type { DurableObject } from 'cloudflare:workers';
import type { TenantPropertiesSchema, UserPropertiesSchema } from 'db';
import type { VaultMigrationParamsSchema } from 'helpers/vault-migration';
import type { DataKeyRotationParamsSchema } from 'helpers/zod/mini';
import type { UUID } from 'node:crypto';
import type { DOJurisdictions } from 'types';
import type { ProjectResponse, SecretResponse } from 'types/bw/schemas';
import type { TenantLogQueueMessageSchema } from 'types/tenants/logging';
import type { ZodPick } from 'types/zod/mini';
import type * as zm from 'zod/mini';
import type { BitwardenSessionProxy, TenantD0LogsProxy, TenantD0Proxy, UserD0Proxy, UserSessionProxy } from '../../do-proxy/src/index';

export interface EnvVars extends Omit<Cloudflare.Env, 'LOGS' | 'DATA_KEY_ROTATION' | 'VAULT_MIGRATION' | 'BITWARDEN_SESSION' | 'TENANT_D0' | 'TENANT_D0_LOGS' | 'USER_D0' | 'BITWARDEN_SESSION_PROXY' | 'TENANT_D0_PROXY' | 'TENANT_D0_LOGS_PROXY' | 'USER_D0_PROXY' | 'USER_SESSION_PROXY'>, TypedBindings {
	GIT_HASH?: string;
	EU_BW_SM_PROJECT_ID: string;
	US_BW_SM_PROJECT_ID: string;
}

interface TypedBindings {
	LOGS: Queue<zm.input<typeof TenantLogQueueMessageSchema>>;
	DATA_KEY_ROTATION: Workflow<zm.input<typeof DataKeyRotationParamsSchema>>;
	VAULT_MIGRATION: Workflow<zm.input<typeof VaultMigrationParamsSchema>>;
	BITWARDEN_SESSION: DurableObjectNamespace<BitwardenSession>;
	TENANT_D0: DurableObjectNamespace<TenantD0>;
	TENANT_D0_LOGS: DurableObjectNamespace<BaseD0>;
	USER_D0: DurableObjectNamespace<UserD0>;
	/**
	 * Local-dev-only proxy to `BITWARDEN_SESSION`. Unused by live code.
	 */
	BITWARDEN_SESSION_PROXY?: Service<BitwardenSessionProxy>;
	/**
	 * Local-dev-only proxy to `TENANT_D0`. Unused by live code.
	 */
	TENANT_D0_PROXY?: Service<TenantD0Proxy>;
	/**
	 * Local-dev-only proxy to `TENANT_D0_LOGS`. Unused by live code.
	 */
	TENANT_D0_LOGS_PROXY?: Service<TenantD0LogsProxy>;
	/**
	 * Local-dev-only proxy to `USER_D0`. Unused by live code.
	 */
	USER_D0_PROXY?: Service<UserD0Proxy>;
	/**
	 * Local-dev-only proxy to this worker's own `USER_SESSION` (auth always runs against the live DB). Unused by live code.
	 */
	USER_SESSION_PROXY?: Service<UserSessionProxy>;
}

/**
 * @link https://developers.cloudflare.com/turnstile/get-started/server-side-validation/#accepted-parameters
 */
export interface TurnstileRequest {
	secret: string;
	response: string;
	remoteip?: string;
	idempotency_key?: UUID;
}

/**
 * @link https://developers.cloudflare.com/turnstile/get-started/server-side-validation/#accepted-parameters
 */
export interface TurnstileResponse {
	success: boolean;
	/**
	 * the ISO timestamp for the time the challenge was solved
	 */
	challenge_ts: ReturnType<Date['toISOString']>;
	/**
	 * the hostname for which the challenge was served
	 */
	hostname: URL['hostname'];
	/**
	 * the customer widget identifier passed to the widget on the client side. This is used to differentiate widgets using the same sitekey in analytics. Its integrity is protected by modifications from an attacker. It is recommended to validate that the action matches an expected value
	 */
	action: string;
	/**
	 * the customer data passed to the widget on the client side. This can be used by the customer to convey state. It is integrity protected by modifications from an attacker
	 */
	cdata: string;
	/**
	 * a list of errors that occurred
	 */
	'error-codes': string[];
}

/**
 * All with `Recommended` as `Yes`
 * @link https://www.iana.org/assignments/cose/cose.xhtml#algorithms
 */
export enum COSEAlgorithms {
	/**
	 * EdDSA using the Ed448 parameter set in Section 5.2 of [RFC8032]
	 */
	Ed448 = -53,
	/**
	 * ECDSA using P-521 curve and SHA-512
	 */
	ESP512 = -52,
	/**
	 * ECDSA using P-384 curve and SHA-384
	 */
	ESP384 = -51,
	/**
	 * CBOR Object Signing Algorithm for ML-DSA-87
	 */
	'ML-DSA-87' = -50,
	/**
	 * CBOR Object Signing Algorithm for ML-DSA-65
	 */
	'ML-DSA-65' = -49,
	/**
	 * CBOR Object Signing Algorithm for ML-DSA-44
	 */
	'ML-DSA-44' = -48,
	/**
	 * HSS/LMS hash-based digital signature
	 */
	'HSS-LMS' = -46,
	/**
	 * SHAKE-256 512-bit Hash Value
	 */
	SHAKE256 = -45,
	/**
	 * SHA-2 512-bit Hash
	 */
	'SHA-512' = -44,
	/**
	 * SHA-2 384-bit Hash
	 */
	'SHA-384' = -43,
	/**
	 * RSAES-OAEP w/ SHA-512
	 */
	'RSAES-OAEP w/ SHA-512' = -42,
	/**
	 * RSAES-OAEP w/ SHA-256
	 */
	'RSAES-OAEP w/ SHA-256' = -41,
	/**
	 * RSAES-OAEP w/ SHA-1
	 */
	'RSAES-OAEP w/ RFC 8017 default parameters' = -40,
	/**
	 * RSASSA-PSS w/ SHA-512
	 */
	PS512 = -39,
	/**
	 * RSASSA-PSS w/ SHA-384
	 */
	PS384 = -38,
	/**
	 * RSASSA-PSS w/ SHA-256
	 */
	PS256 = -37,
	/**
	 * ECDSA w/ SHA-512
	 * @deprecated
	 */
	ES512 = -36,
	/**
	 * ECDSA w/ SHA-384
	 * @deprecated
	 */
	ES384 = -35,
	/**
	 * ECDH SS w/ Concat KDF and AES Key Wrap w/ 256-bit key
	 */
	'ECDH-SS + A256KW' = -34,
	/**
	 * ECDH SS w/ Concat KDF and AES Key Wrap w/ 192-bit key
	 */
	'ECDH-SS + A192KW' = -33,
	/**
	 * ECDH SS w/ Concat KDF and AES Key Wrap w/ 128-bit key
	 */
	'ECDH-SS + A128KW' = -32,
	/**
	 * ECDH ES w/ Concat KDF and AES Key Wrap w/ 256-bit key
	 */
	'ECDH-ES + A256KW' = -31,
	/**
	 * ECDH ES w/ Concat KDF and AES Key Wrap w/ 192-bit key
	 */
	'ECDH-ES + A192KW' = -30,
	/**
	 * ECDH ES w/ Concat KDF and AES Key Wrap w/ 128-bit key
	 */
	'ECDH-ES + A128KW' = -29,
	/**
	 * ECDH SS w/ HKDF - generate key directly
	 */
	'ECDH-SS + HKDF-512' = -28,
	/**
	 * ECDH SS w/ HKDF - generate key directly
	 */
	'ECDH-SS + HKDF-256' = -27,
	/**
	 * ECDH ES w/ HKDF - generate key directly
	 */
	'ECDH-ES + HKDF-512' = -26,
	/**
	 * ECDH ES w/ HKDF - generate key directly
	 */
	'ECDH-ES + HKDF-256' = -25,
	/**
	 * EdDSA using the Ed25519 parameter set in Section 5.1 of [RFC8032]
	 */
	Ed25519 = -19,
	/**
	 * SHAKE-128 256-bit Hash Value
	 */
	SHAKE128 = -18,
	/**
	 * SHA-2 512-bit Hash truncated to 256-bits
	 */
	'SHA-512/256' = -17,
	/**
	 * SHA-2 256-bit Hash
	 */
	'SHA-256' = -16,
	/**
	 * Shared secret w/ AES-MAC 256-bit key
	 */
	'direct+HKDF-AES-256' = -13,
	/**
	 * Shared secret w/ AES-MAC 128-bit key
	 */
	'direct+HKDF-AES-128' = -12,
	/**
	 * Shared secret w/ HKDF and SHA-512
	 */
	'direct+HKDF-SHA-512' = -11,
	/**
	 * Shared secret w/ HKDF and SHA-256
	 */
	'direct+HKDF-SHA-256' = -10,
	/**
	 * ECDSA using P-256 curve and SHA-256
	 */
	ESP256 = -9,
	/**
	 * ECDSA w/ SHA-256
	 * @deprecated
	 */
	ES256 = -7,
	/**
	 * Direct use of CEK
	 */
	direct = -6,
	/**
	 * AES Key Wrap w/ 256-bit key
	 */
	A256KW = -5,
	/**
	 * AES Key Wrap w/ 192-bit key
	 */
	A192KW = -4,
	/**
	 * AES Key Wrap w/ 128-bit key
	 */
	A128KW = -3,
	/**
	 * AES-GCM mode w/ 128-bit key, 128-bit tag
	 */
	A128GCM = 1,
	/**
	 * AES-GCM mode w/ 192-bit key, 128-bit tag
	 */
	A192GCM = 2,
	/**
	 * AES-GCM mode w/ 256-bit key, 128-bit tag
	 */
	A256GCM = 3,
	/**
	 * HMAC w/ SHA-256 truncated to 64 bits
	 */
	'HMAC 256/64' = 4,
	/**
	 * HMAC w/ SHA-256
	 */
	'HMAC 256/256' = 5,
	/**
	 * HMAC w/ SHA-384
	 */
	'HMAC 384/384' = 6,
	/**
	 * HMAC w/ SHA-512
	 */
	'HMAC 512/512' = 7,
	/**
	 * AES-CCM mode 128-bit key, 64-bit tag, 13-byte nonce
	 */
	'AES-CCM-16-64-128' = 10,
	/**
	 * AES-CCM mode 256-bit key, 64-bit tag, 13-byte nonce
	 */
	'AES-CCM-16-64-256' = 11,
	/**
	 * AES-CCM mode 128-bit key, 64-bit tag, 7-byte nonce
	 */
	'AES-CCM-64-64-128' = 12,
	/**
	 * AES-CCM mode 256-bit key, 64-bit tag, 7-byte nonce
	 */
	'AES-CCM-64-64-256' = 13,
	/**
	 * AES-MAC 128-bit key, 64-bit tag
	 */
	'AES-MAC 128/64' = 14,
	/**
	 * AES-MAC 256-bit key, 64-bit tag
	 */
	'AES-MAC 256/64' = 15,
	/**
	 * ChaCha20/Poly1305 w/ 256-bit key, 128-bit tag
	 */
	'ChaCha20/Poly1305' = 24,
	/**
	 * AES-MAC 128-bit key, 128-bit tag
	 */
	'AES-MAC 128/128' = 25,
	/**
	 * AES-MAC 256-bit key, 128-bit tag
	 */
	'AES-MAC 256/128' = 26,
	/**
	 * AES-CCM mode 128-bit key, 128-bit tag, 13-byte nonce
	 */
	'AES-CCM-16-128-128' = 30,
	/**
	 * AES-CCM mode 256-bit key, 128-bit tag, 13-byte nonce
	 */
	'AES-CCM-16-128-256' = 31,
	/**
	 * AES-CCM mode 128-bit key, 128-bit tag, 7-byte nonce
	 */
	'AES-CCM-64-128-128' = 32,
	/**
	 * AES-CCM mode 256-bit key, 128-bit tag, 7-byte nonce
	 */
	'AES-CCM-64-128-256' = 33,
}

interface ProjectResponsEnhanced extends Omit<ProjectResponse, 'id'> {
	id: UUID;
	read: boolean;
	write: boolean;
}
interface SecretsProject {
	id: UUID;
	name: string;
}
declare class BitwardenSession extends DurableObject {
	public init(_options: {
		t_jurisdiction: DOJurisdictions | null;
		t_do_id: ArrayBuffer | null;
		t_id: string | null;
		u_id: string | null;
		ak_id: string | null;
		endpoints: {
			base: string;
			authentication: string;
		};
	}): Promise<void>;
	public auth(accessToken: string): Promise<void>;
	public getProjects(): Promise<ProjectResponsEnhanced[]>;
	public getSecretsAndProjects(): Promise<{
		projects: SecretsProject[];
		secrets: {
			creationDate: string;
			id: UUID;
			key: string;
			organizationId: UUID;
			projects: SecretsProject[];
			read: boolean;
			revisionDate: string;
			write: boolean;
		}[];
	}>;
	public getSecrets(_secretIds: string[]): Promise<
		{
			creationDate: string;
			id: UUID;
			key: string;
			note: string;
			object: string;
			organizationId: UUID;
			projects: SecretsProject[];
			revisionDate: string;
			value: string;
		}[]
	>;
	public setSecret(_options: { projectId: string; key: string; value: string; note?: string | undefined }): Promise<SecretResponse>;
	public deleteSecrets(_secretIds: string[]): Promise<UUID[]>;
	public decryptSecret(accessToken: string, cipherText: string): Promise<string>;
	public encryptSecret(accessToken: string, plainText: string, iv?: Buffer, version?: 0 | 1 | 2): Promise<string>;
	/**
	 * Rejects when this session can't take work - already at its concurrency cap, or no longer authenticated. See `acquireBitwardenSession` in `helpers/bitwarden-sessions`.
	 */
	public available(): Promise<{ expires: Date }>;
	public activeTasks(): { active: number; max: number };

	/** `tenantGone` is for a tenant tearing itself down (`TenantD0.purge`) — it skips the closing audit row and the pool deregistration, both of which would otherwise be addressed to a tenant that no longer exists */
	public nuke(reason?: string, hard?: boolean, tenantGone?: boolean): Promise<void>;
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

/**
 * One row of {@link TenantD0.getSchedule}/{@link TenantD0.getSchedules}, mirroring the `alarms` table.
 */
export interface TenantScheduleRow {
	id: UUID;
	callee: string;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	payload: any[];
	type: 'scheduled' | 'delayed' | 'cron';
	next_time: Date;
	delay_in_seconds: number | null;
	cron: string[] | null;
}

export declare class TenantD0 extends BaseD0 {
	public registerBitwardenSession(_options: { do_id: string; fingerprint: string; expires: Date }): Promise<void>;
	public listBitwardenSessions(_options?: { fingerprint?: string; includeExpired?: boolean }): Promise<PooledBitwardenSession[]>;
	public unregisterBitwardenSession(do_id: string): Promise<void>;
	public getProperties(_keys?: ZodPick<typeof TenantPropertiesSchema>, lazy?: boolean): Promise<Partial<zm.output<typeof TenantPropertiesSchema>>>;
	public getPropertiesSync(_keys?: ZodPick<typeof TenantPropertiesSchema>): Partial<zm.output<typeof TenantPropertiesSchema>>;
	public updateProperties(_properties: Partial<zm.input<typeof TenantPropertiesSchema>>, background?: boolean, lazy?: boolean): Promise<Partial<zm.output<typeof TenantPropertiesSchema>>>;
	public updatePropertiesSync(_properties: Partial<zm.input<typeof TenantPropertiesSchema>>, background?: boolean, lazy?: boolean): Partial<zm.output<typeof TenantPropertiesSchema>>;
	/**
	 * Records a schedule row (`when` as a cron array arms a recurring `type: 'cron'` alarm) and arms the Durable Object alarm for whichever row is due next. `id` defaults to a fresh one - pass the same `id` back to replace an existing schedule instead of accumulating a second row (`cancelSchedule` first; `schedule` doesn't upsert).
	 *
	 * Two deliberate departures from the real `TenantD0.schedule` this mirrors, both to keep this class's RPC stub type-checkable at all:
	 * - `callee` is a plain `string`, not `MethodNames<TenantD0>` - a self-referential type here (this class naming its own methods, inside its own method's signature) is what was sending `Provider<TenantD0>`'s mapped type into "Type instantiation is excessively deep" territory, and not just for this method - it was enough to flip an unrelated, already-fragile `@ts-expect-error` elsewhere in the worker. The real `TenantD0.alarm()` still validates the callee at dispatch time (an unknown one just gets logged and the schedule deleted), so this only gives up a compile-time typo check, not a real one.
	 * - `payload` is `any[]`, not generic: `unknown[]` fails a stubbed method's `Serializable<T>` check (unknown isn't known to be *anything* serializable), collapsing the whole call to `never`; `any` bypasses that check instead of failing it. Nothing in `customer` needs the payload's specific tuple type reflected back through the return value anyway.
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	public schedule(when: Date | number | string[], callee: string, payload?: any[], id?: UUID): Promise<{ id: UUID; payload: any[]; next_time: Date; type: 'scheduled' | 'delayed' | 'cron' }>;
	// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
	public getSchedule(id: UUID | string): Promise<TenantScheduleRow | undefined>;
	/**
	 * Returns an inline shape rather than `TenantScheduleRow[]` - an *array* of that interface, through this RPC stub's mapped type, is what was hitting "Type instantiation is excessively deep" (a single one, as `getSchedule` returns, was fine). Add fields here only as callers actually need them.
	 */
	// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
	public getSchedules(criteria?: { id?: UUID | string; type?: 'scheduled' | 'delayed' | 'cron'; timeRange?: { start?: Date; end?: Date } }): Promise<{ id: UUID; cron: string[] | null }[]>;
	// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
	public cancelSchedule(id: UUID | string): Promise<void>;
	/**
	 * The `callee` a keyring's `time_rotation` cron schedule fires - triggers `DATA_KEY_ROTATION` for the given keyring as `system`. Never called directly from the dashboard; only named as a `schedule()` `callee` argument.
	 */
	public rotateKeyringOnSchedule(t_id_hex: string, kr_id_hex: string): Promise<void>;
}
export declare class UserD0 extends BaseD0 {
	public getProperties(_keys?: ZodPick<typeof UserPropertiesSchema>, lazy?: boolean): Promise<Partial<zm.output<typeof UserPropertiesSchema>>>;
	public getPropertiesSync(_keys?: ZodPick<typeof UserPropertiesSchema>): Partial<zm.output<typeof UserPropertiesSchema>>;
	public updateProperties(_properties: Partial<zm.input<typeof UserPropertiesSchema>>, background?: boolean, lazy?: boolean): Promise<Partial<zm.output<typeof UserPropertiesSchema>>>;
	public updatePropertiesSync(_properties: Partial<zm.input<typeof UserPropertiesSchema>>, background?: boolean, lazy?: boolean): Partial<zm.output<typeof UserPropertiesSchema>>;
}
