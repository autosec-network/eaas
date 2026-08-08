import { Buffer } from 'node:buffer';
import { TenantVerificationAction } from 'types/tenants/verification';
import * as zm from 'zod/mini';
import { ZodUuidInputConverted } from './zod-mini/index.js';

/**
 * `type` of the event the dashboard sends to release a waiting migration workflow. Must satisfy Cloudflare's `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`.
 */
export const VAULT_MIGRATION_APPROVAL_EVENT = 'vault-migration-approved';

/**
 * The vault the tenant is migrating *to*, as the dashboard captured it.
 *
 * This never travels or rests in the clear: the dashboard seals it with {@link sealVaultConfig} before handing it to the workflow, because Cloudflare persists workflow parameters (and every step's return value) as plaintext.
 */
export const VaultMigrationConfigSchema = zm.discriminatedUnion('mode', [
	zm.object({
		/**
		 * Back onto our own Bitwarden organization.
		 */
		mode: zm.literal('managed'),
	}),
	zm.object({
		/**
		 * The tenant's own Bitwarden Secrets Manager organization.
		 */
		mode: zm.literal('bitwarden'),
		accessToken: zm.string().check(zm.trim(), zm.minLength(1)),
		project: zm.uuidv4().check(zm.trim()),
		endpoints: zm.object({
			base: zm.url({ protocol: /^https$/, hostname: zm.regexes.domain, normalize: true }),
			authentication: zm.url({ protocol: /^https$/, hostname: zm.regexes.domain, normalize: true }),
		}),
	}),
]);

/**
 * Which workflow instance and action a raw approval token is good for, and until when - the payload of the link's `approval` parameter.
 *
 * Sealed under a key derived from the *same* raw token that also appears (in the clear) in the link's `token` parameter, so the pairing is only as strong as ChaCha20-Poly1305's authentication tag: a token minted for one instance cannot be paired with a different instance's `approval` blob and successfully unseal, because the derived key won't match. That's what makes `instance` untrustworthy as ordinary client input safe to drop from the redemption flow - it's derivable *only* by whoever already holds the matching token.
 */
export const VaultMigrationApprovalSchema = zm.object({
	instance: zm.string().check(zm.trim(), zm.minLength(1)),
	action: zm.enum(TenantVerificationAction),
	expires: zm.iso.datetime({ local: false, offset: false, precision: 3 }),
});

/**
 * A sealed JSON payload, in the compact shape that travels as a single URL query parameter (see {@link encodeEnvelope}/{@link decodeEnvelope}).
 */
export const VaultMigrationEnvelopeSchema = zm.object({
	/**
	 * 96-bit ChaCha20-Poly1305 nonce.
	 */
	nonce: zm.base64url().check(zm.trim(), zm.length(16)),
	ciphertext: zm.base64url().check(zm.trim(), zm.minLength(1)),
	/**
	 * 128-bit Poly1305 authentication tag.
	 */
	tag: zm.base64url().check(zm.trim(), zm.length(22)),
});

/**
 * Defined in `helpers/vault-migration` rather than the workflow itself: the dashboard builds this payload and the workflow parses it, from two different workers, so a single definition is the only thing keeping them in step.
 */
export const VaultMigrationParamsSchema = zm.object({
	/**
	 * The tenant being migrated *away from*. The workflow builds its replacement.
	 */
	t_id: ZodUuidInputConverted(7),
	action: zm.enum(TenantVerificationAction),
	/**
	 * The destination vault, sealed with {@link sealVaultConfig}. Cloudflare stores workflow parameters in plaintext, so this is the only form the tenant's Bitwarden credentials may take here.
	 */
	config: VaultMigrationEnvelopeSchema,
});

/**
 * Derive the ChaCha20-Poly1305 key a raw approval token seals or unseals with.
 *
 * **sha256, deliberately different from the sha512 stored in `verification_tokens.hashed_token`.** Both are functions of the same secret, so using one digest for both would mean anyone who can read the tenant's DB could also unseal anything sealed under this key. Only someone holding the raw token - which exists solely in the approval email - can do that.
 */
async function envelopeKey(rawToken: Buffer) {
	return import('node:crypto').then(({ createHash }) => createHash('sha256').update(rawToken).digest());
}

/**
 * Digest stored in `verification_tokens.hashed_token`, and the one to look a redeemed token up by. See {@link envelopeKey} for why this is a different algorithm.
 */
export function vaultMigrationTokenDigest(rawToken: Buffer) {
	return import('node:crypto').then(({ createHash }) => createHash('sha512').update(rawToken).digest('hex'));
}

/**
 * Seal `value` under a key derived from `rawToken`. The only way to recover it is to already hold that exact token - not a hash of it, not a different token, and not a token minted for a different purpose.
 */
async function seal<T extends zm.ZodMiniType>(rawToken: Buffer, schema: T, _value: zm.input<T>): Promise<zm.output<typeof VaultMigrationEnvelopeSchema>> {
	const [value, key, { createCipheriv, randomBytes }] = await Promise.all([schema.parseAsync(_value) as Promise<zm.output<T>>, envelopeKey(rawToken), import('node:crypto')]);

	const nonce = randomBytes(96 / 8);
	const cipher = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 128 / 8 });
	const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);

	return {
		nonce: nonce.toString('base64url'),
		ciphertext: ciphertext.toString('base64url'),
		tag: cipher.getAuthTag().toString('base64url'),
	};
}

/**
 * Reverse of {@link seal}. Throws (auth tag verification failure, or - upstream of that - a schema mismatch on the recovered plaintext) if `rawToken` isn't the exact token `envelope` was sealed with.
 */
async function unseal<T extends zm.ZodMiniType>(rawToken: Buffer, schema: T, _envelope: zm.input<typeof VaultMigrationEnvelopeSchema>): Promise<zm.output<T>> {
	const [envelope, key, { createDecipheriv }] = await Promise.all([VaultMigrationEnvelopeSchema.parseAsync(_envelope), envelopeKey(rawToken), import('node:crypto')]);

	const decipher = createDecipheriv('chacha20-poly1305', key, Buffer.from(envelope.nonce, 'base64url'), { authTagLength: 128 / 8 });
	decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));

	return schema.parseAsync(JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final()]).toString('utf8')));
}

/**
 * Seal a target vault config so it can be handed to the migration workflow as a parameter.
 *
 * Callers must keep the return value **inside** whatever workflow step needs it; returning the *unsealed* form from a step would write the tenant's Bitwarden access token to Cloudflare's plaintext step log.
 */
export const sealVaultConfig = (rawToken: Buffer, config: zm.input<typeof VaultMigrationConfigSchema>) => seal(rawToken, VaultMigrationConfigSchema, config);

/**
 * Reverse of {@link sealVaultConfig}.
 */
export const unsealVaultConfig = (rawToken: Buffer, envelope: zm.input<typeof VaultMigrationEnvelopeSchema>) => unseal(rawToken, VaultMigrationConfigSchema, envelope);

/**
 * Seal which workflow instance/action a token approves, for the email link's `approval` parameter.
 *
 * This is what stands in for a `verification_tokens` row lookup on the read-only GET path: the link is self-certifying (whoever can unseal it necessarily holds the matching token), so rendering the confirmation page never has to touch the tenant DB. The DB row still gets consulted once, at redemption (POST) time, purely to enforce single use.
 */
export const sealApproval = (rawToken: Buffer, approval: zm.input<typeof VaultMigrationApprovalSchema>) => seal(rawToken, VaultMigrationApprovalSchema, approval);

/**
 * Reverse of {@link sealApproval}. A token minted for one workflow instance can never unseal an `approval` blob minted for another - the derived key won't match, so this throws instead of returning a mismatched `instance`. That's the property that makes it safe to trust the recovered `instance`/`action` without an extra DB round trip: nothing short of holding the exact right token can produce them.
 */
export const unsealApproval = (rawToken: Buffer, envelope: zm.input<typeof VaultMigrationEnvelopeSchema>) => unseal(rawToken, VaultMigrationApprovalSchema, envelope);

/**
 * Pack a {@link VaultMigrationEnvelopeSchema} into a single URL-safe string. Every field is already base64url, so `.` (outside that alphabet) is an unambiguous separator.
 */
export function encodeEnvelope(envelope: zm.output<typeof VaultMigrationEnvelopeSchema>) {
	return [envelope.nonce, envelope.ciphertext, envelope.tag].join('.');
}

/**
 * Reverse of {@link encodeEnvelope}. Returns `undefined` for anything that isn't a well-formed three-part envelope, so callers can treat a malformed link the same as one that fails to unseal.
 */
export function decodeEnvelope(packed: string): zm.input<typeof VaultMigrationEnvelopeSchema> | undefined {
	const [nonce, ciphertext, tag, ...rest] = packed.split('.');
	if (!nonce || !ciphertext || !tag || rest.length > 0) return undefined;
	return { nonce, ciphertext, tag };
}
