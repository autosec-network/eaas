import { z } from '@builder.io/qwik-city';
import type { Cloudflare } from 'cloudflare';
import * as rootSchema from 'db/schemas/root';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { eq, sql } from 'drizzle-orm/sql';
import { Buffer } from 'node:buffer';
import { DOJurisdictions } from 'types';
import * as zm from 'zod/mini';
import { hexToUuid } from '~/routes/[environment]/users/db-helpers';
import type { EnvVars } from '~/types';

/**
 * A UUIDv7 as it can be typed into the admin UI — utf8 (hyphenated), hex, base64, or base64url — normalized to hex for the `unhex()` calls every blob column needs.
 */
export const uuidAnyFormatSchema = z.union([
	z
		.string()
		.trim()
		.uuid()
		.refine((val) => zm.uuidv7().safeParse(val).success, 'Must be a valid UUIDv7')
		.transform((uuid) => uuid.replaceAll('-', '')),
	z
		.string()
		.trim()
		.toLowerCase()
		.length(32)
		.refine((val) => zm.hex().safeParse(val).success, 'Must be a valid UUIDv7 without hyphens'),
	z
		.string()
		.trim()
		.length(24)
		.base64()
		.transform((base64) => Buffer.from(base64, 'base64').toString('hex')),
	z
		.string()
		.trim()
		.length(22)
		.base64url()
		.transform((base64url) => Buffer.from(base64url, 'base64url').toString('hex')),
]);

/** The route param is always the short form, so tenant links stay copy-pasteable */
export const tenantIdParamSchema = zm.base64url().check(zm.length(22));

/** Normalizes an id read out of the query string (a filter, a deep link) to hex, or `null` when it isn't a usable id */
export function paramIdToHex(value: string | null): string | null {
	if (!value) return null;

	const parsed = uuidAnyFormatSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

/** The stubs the `[tid]` layout puts on `sharedMap` for its tabs to read */
export type TenantDoStub = ReturnType<EnvVars['TENANT_D0_PROD']['get']>;
export type TenantLogsDoStub = ReturnType<EnvVars['TENANT_D0_LOGS_PROD']['get']>;

/** A tenant's logs live in their own DO, named after the tenant with a `_logs` suffix so it's derivable from `t_id` alone */
export function tenantLogsDoName(t_id_hex: string) {
	return `${hexToUuid(t_id_hex)}_logs`;
}

/**
 * Derives the tenant's DO id. Falls back to `idFromName` (how onboarding minted it) when the root lookup row is missing, so a tenant that only exists as a Durable Object is still reachable.
 */
export function resolveTenantDoId(namespace: EnvVars['TENANT_D0_PROD'], jurisdiction: DOJurisdictions | null, t_id_hex: string, do_id_hex?: string | null) {
	const jurisdictionalNamespace = jurisdiction ? namespace.jurisdiction(jurisdiction) : namespace;
	return do_id_hex ? jurisdictionalNamespace.idFromString(do_id_hex) : jurisdictionalNamespace.idFromName(hexToUuid(t_id_hex));
}

/** The logs DO id is never stored in root — it's always derived from the tenant id */
export function resolveTenantLogsDoId(namespace: EnvVars['TENANT_D0_LOGS_PROD'], jurisdiction: DOJurisdictions | null, t_id_hex: string) {
	const jurisdictionalNamespace = jurisdiction ? namespace.jurisdiction(jurisdiction) : namespace;
	return jurisdictionalNamespace.idFromName(tenantLogsDoName(t_id_hex));
}

/**
 * Same as {@link resolveTenantLogsDoId} but hands back `null` instead of throwing — local `workerd` rejects jurisdictional `idFromName`, and a whole page of tenants shouldn't 500 because of it.
 */
export function tryResolveTenantLogsDoIdHex(namespace: EnvVars['TENANT_D0_LOGS_PROD'], jurisdiction: DOJurisdictions | null, t_id_hex: string) {
	try {
		return resolveTenantLogsDoId(namespace, jurisdiction, t_id_hex).toString();
	} catch (error) {
		console.warn('Unable to derive logs durable object id for tenant', t_id_hex, error);
		return null;
	}
}

/**
 * Rebuilds a `DurableObjectId` from its hex string when the jurisdiction isn't known — an orphaned object has no root row left to say which one it was minted in, and `idFromString` only accepts ids belonging to the (sub)namespace it's called on.
 */
export function resolveDoIdFromString<T extends Rpc.DurableObjectBranded | undefined>(namespace: DurableObjectNamespace<T>, doIdHex: string) {
	const candidates = [namespace, ...Object.values(DOJurisdictions).map((jurisdiction) => namespace.jurisdiction(jurisdiction))];

	for (const candidate of candidates) {
		try {
			return candidate.idFromString(doIdHex);
		} catch {
			continue;
		}
	}

	throw new Error(`\`${doIdHex}\` is not a valid durable object id for this namespace`);
}

/** Every live object in a Durable Object namespace, mapped to whether it actually holds stored data */
export async function listDoInstances(cf: Cloudflare, accountId: string, namespaceId: string) {
	const instances: Record<string, boolean> = {};

	for await (const instance of cf.durableObjects.namespaces.objects.list(namespaceId, {
		account_id: accountId,
		limit: 10000,
	})) {
		if (instance.id) instances[instance.id] = instance.hasStoredData ?? false;
	}

	return instances;
}

/**
 * Narrower version of {@link listDoInstances} for pages that only care about a handful of ids — stops paging as soon as they've all been seen.
 */
export async function lookupDoInstances(cf: Cloudflare, accountId: string, namespaceId: string, ids: string[]) {
	const wanted = new Set(ids.filter(Boolean));
	const instances: Record<string, boolean> = {};

	if (wanted.size === 0) return instances;

	for await (const instance of cf.durableObjects.namespaces.objects.list(namespaceId, {
		account_id: accountId,
		limit: 10000,
	})) {
		// eslint-disable-next-line drizzle/enforce-delete-with-where -- `Set`, not a drizzle query
		if (instance.id && wanted.delete(instance.id)) {
			instances[instance.id] = instance.hasStoredData ?? false;
			if (wanted.size === 0) break;
		}
	}

	return instances;
}

/**
 * Deletes a tenant everywhere it exists: its Durable Object, its logs Durable Object, and every root lookup row pointing at it.
 *
 * The Durable Objects go first — `do_id` only lives in the root row, so dropping that row before the wipes would strand storage nobody can address anymore. A failed wipe therefore leaves the root rows intact and throws, making the delete safe to retry.
 */
export async function purgeTenant(options: { r_db: DrizzleD1Database; t_id_hex: string; jurisdiction: DOJurisdictions | null; do_id_hex?: string | null; tenantNamespace: EnvVars['TENANT_D0_PROD']; logsNamespace: EnvVars['TENANT_D0_LOGS_PROD'] }) {
	const { r_db, t_id_hex, jurisdiction, do_id_hex, tenantNamespace, logsNamespace } = options;

	await Promise.allSettled([
		//
		tenantNamespace.get(resolveTenantDoId(tenantNamespace, jurisdiction, t_id_hex, do_id_hex)).nuke('Tenant deleted by admin'),
		logsNamespace.get(resolveTenantLogsDoId(logsNamespace, jurisdiction, t_id_hex)).nuke('Tenant deleted by admin'),
	]).then((settled) => {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-return
		const errors = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason);

		if (errors.length > 0) throw new AggregateError(errors, 'Failed to wipe one or more of the tenant durable objects. Root references were left intact so the delete can be retried.');
	});

	// `users_tenants.t_id` and `api_keys_tenants.t_id` both cascade on delete, so the tenant row is all it takes to clear every root reference
	await r_db
		.delete(rootSchema.tenants)
		.where(eq(rootSchema.tenants.t_id, sql`unhex(${t_id_hex})`))
		.limit(1);
}

/** One shape for every failure, so `fail()` payloads keep named properties instead of collapsing into an index signature */
export function serializeActionError(err: unknown): { name: string; message: string; cause: string | undefined } {
	if (err instanceof Error) {
		return {
			name: err.name,
			message: err.message,
			cause: err.cause instanceof Error ? err.cause.message : typeof err.cause === 'string' ? err.cause : undefined,
		};
	}

	return {
		name: 'Error',
		message: typeof err === 'string' ? err : JSON.stringify(err),
		cause: undefined,
	};
}
