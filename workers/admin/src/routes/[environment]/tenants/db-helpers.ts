import { Permissions } from 'types';
import { TenantLogEventStatus, TenantLogEventType } from 'types/tenants/logging';

/** `[label, value]` pairs for a numeric enum, dropping the reverse-mapped keys TypeScript adds */
function numericEnumEntries<TEnum extends Record<string, string | number>>(enumObject: TEnum): [string, TEnum[keyof TEnum] & number][] {
	return Object.entries(enumObject).filter((entry): entry is [string, TEnum[keyof TEnum] & number] => typeof entry[1] === 'number');
}

export const TENANT_LOG_EVENT_OPTIONS = numericEnumEntries(TenantLogEventType);
export const TENANT_LOG_STATUS_OPTIONS = numericEnumEntries(TenantLogEventStatus);
export const PERMISSION_OPTIONS = numericEnumEntries(Permissions);

const TENANT_LOG_EVENT_LABELS = new Map(TENANT_LOG_EVENT_OPTIONS.map(([label, value]) => [value, label]));
const TENANT_LOG_STATUS_LABELS = new Map(TENANT_LOG_STATUS_OPTIONS.map(([label, value]) => [value, label]));
const PERMISSION_LABELS = new Map(PERMISSION_OPTIONS.map(([label, value]) => [value, label]));

/** Log rows store raw enum numbers, so anything not in the enum is surfaced rather than hidden */
export function tenantLogEventLabel(eventType: TenantLogEventType): string {
	return TENANT_LOG_EVENT_LABELS.get(eventType) ?? `Unknown (${eventType})`;
}

export function tenantLogStatusLabel(status: TenantLogEventStatus): string {
	return TENANT_LOG_STATUS_LABELS.get(status) ?? `Unknown (${status})`;
}

export function permissionLabel(value: Permissions): string {
	return PERMISSION_LABELS.get(value) ?? `Unknown (${value})`;
}

/**
 * Pulls a readable message out of a `routeAction$` failure. Qwik unions the action's own `fail()` payloads with the validator's `formErrors`/`fieldErrors`, and reading those through the union's index signature is both awkward and lossy — this keeps validation messages (e.g. a malformed id) visible instead of swallowing them behind a generic fallback.
 */
export function actionErrorMessage(value: unknown, fallback: string): string {
	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>;

		if (typeof record['message'] === 'string' && record['message']) return record['message'];

		const formErrors = record['formErrors'];
		if (Array.isArray(formErrors)) {
			const formError = formErrors.find((entry): entry is string => typeof entry === 'string');
			if (formError) return formError;
		}

		const fieldErrors = record['fieldErrors'];
		if (fieldErrors && typeof fieldErrors === 'object') {
			const fieldError = Object.entries(fieldErrors)
				.flatMap(([field, errors]) => (Array.isArray(errors) ? errors.map((error: unknown) => [field, error] as const) : [[field, errors] as const]))
				.find((entry): entry is readonly [string, string] => typeof entry[1] === 'string');
			if (fieldError) return `${fieldError[0]}: ${fieldError[1]}`;
		}
	}

	return fallback;
}

/** Every tab of a tenant is its own route segment, so switching tabs (and any filter inside one) is bookmarkable */
export const TENANT_TABS = [
	{ label: 'Properties', segment: 'properties' },
	{ label: 'Users', segment: 'users' },
	{ label: 'API Keys', segment: 'api-keys' },
	{ label: 'Bitwarden Sessions', segment: 'bitwarden-sessions' },
	{ label: 'Logs', segment: 'logs' },
] as const;
