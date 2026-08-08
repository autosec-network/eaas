/**
 * What a pending row in a tenant's `verification_tokens` table authorizes once its token is redeemed.
 *
 * Deliberately a **string** enum: the values go straight into the schema's `text({ enum })` via `Object.values()`, so they have to be the literal strings SQLite stores. A numeric enum would need the `Object.values(...).slice(length / 2)` dance `keyrings.key_type` uses, and would make the stored value unreadable.
 *
 * Only vault migrations need out-of-band approval today, so both members describe one. Expect this to grow - anything reading the table should match against the members it cares about (`inArray(...)`) rather than assuming these two are all of them.
 */
export enum TenantVerificationAction {
	/**
	 * Move the tenant onto a different vault (managed ↔ BYO, or different endpoints/project) and carry every keyring and datakey across to it.
	 *
	 * Destroys nothing the tenant can't get back, so approval from a member with `r_tenant >= Permissions.Write` is enough.
	 */
	'migrate and transfer' = 'migrate_transfer',
	/**
	 * Move the tenant onto a different vault and drop every existing keyring and datakey instead of carrying them over - for tenants who already moved their key material by hand, or who want a clean slate.
	 *
	 * Irreversible, so it takes approval from a member with `r_tenant >= Permissions.Admin`.
	 */
	'migrate and delete' = 'migrate_delete',
}
