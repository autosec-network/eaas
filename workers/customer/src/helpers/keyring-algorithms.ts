import { KeyAlgorithms } from 'types/crypto';
import type { workersCryptoCatalog } from 'types/crypto/catalog';

export const DEFAULT_KEYRING_HASH: (typeof workersCryptoCatalog.hashes)[number] = 'sha512' as const;

/**
 * Enum members in declaration order, each paired with the enum **key** - which is already the display name (`AES-GCM`, `SLH-DSA-SHAKE-F`) the stored value (`aes-gcm`) is the lowercase of.
 */
export const KEY_ALGORITHM_ENTRIES = Object.entries(KeyAlgorithms);

/**
 * Every stored `key_type`, as the non-empty tuple `z.enum()` wants.
 *
 * {@link KeyAlgorithms} is a **string** enum, so it has no reverse mapping and `Object.values()` is already exactly its members - no halving, which is the bug `keyrings.key_type` carried in `shared/db/src/schemas/tenant/main/index.ts`.
 */
export const KEY_ALGORITHM_VALUES = Object.values(KeyAlgorithms) as [KeyAlgorithms, ...KeyAlgorithms[]];

/**
 * What `key_size` means for a given algorithm, mirroring the `switch (key_size)` blocks in `workers/api/wf/dataKeyRotation.ts`.
 *
 * `none` is not "unconstrained" - it means the algorithm takes no size at all (`hmac`, `ed25519`, `x25519`), so the column stays `NULL`.
 */
export type KeySizeRule = { kind: 'none' } | { kind: 'choice'; options: readonly number[]; fallback: number } | { kind: 'range'; min: number; max: number; step: number; fallback: number };

/**
 * Written out per member rather than derived, because `Record<KeyAlgorithms, ...>` is what makes this exhaustive: an algorithm added to the enum fails to compile here until someone says what its `key_size` means.
 *
 * Every `fallback` is the size `dataKeyRotation` would have inferred on its own from {@link DEFAULT_KEYRING_HASH}, so a keyring created with the form's defaults generates the same key whether or not `key_size` survives.
 */
export const KEY_SIZE_RULES: Readonly<Record<KeyAlgorithms, KeySizeRule>> = {
	// Fed straight to `modulusLength` whenever it's a multiple of 8
	[KeyAlgorithms['RSASSA-PKCS1-v1_5']]: { kind: 'range', min: 256, max: 16 * 1024, step: 8, fallback: 2048 },
	[KeyAlgorithms['RSA-PSS']]: { kind: 'range', min: 256, max: 16 * 1024, step: 8, fallback: 2048 },
	[KeyAlgorithms['RSA-OAEP']]: { kind: 'range', min: 256, max: 16 * 1024, step: 8, fallback: 2048 },
	// Curve tiers: 256 -> P-256, 384 -> P-384, 521 -> P-521
	[KeyAlgorithms.ECDSA]: { kind: 'choice', options: [256, 384, 521], fallback: 256 },
	[KeyAlgorithms.ECDH]: { kind: 'choice', options: [256, 384, 521], fallback: 256 },
	[KeyAlgorithms.HMAC]: { kind: 'none' },
	[KeyAlgorithms['AES-CTR']]: { kind: 'choice', options: [128, 192, 256], fallback: 128 },
	[KeyAlgorithms['AES-CBC']]: { kind: 'choice', options: [128, 192, 256], fallback: 128 },
	[KeyAlgorithms['AES-GCM']]: { kind: 'choice', options: [128, 192, 256], fallback: 128 },
	[KeyAlgorithms['AES-KW']]: { kind: 'choice', options: [128, 192, 256], fallback: 128 },
	[KeyAlgorithms.Ed25519]: { kind: 'none' },
	[KeyAlgorithms.X25519]: { kind: 'none' },
	[KeyAlgorithms['ML-KEM']]: { kind: 'choice', options: [512, 768, 1024], fallback: 512 },
	[KeyAlgorithms['ML-DSA']]: { kind: 'choice', options: [44, 65, 87], fallback: 44 },
	[KeyAlgorithms['SLH-DSA-SHA2-S']]: { kind: 'choice', options: [128, 192, 256], fallback: 128 },
	[KeyAlgorithms['SLH-DSA-SHA2-F']]: { kind: 'choice', options: [128, 192, 256], fallback: 128 },
	[KeyAlgorithms['SLH-DSA-SHAKE-S']]: { kind: 'choice', options: [128, 192, 256], fallback: 128 },
	[KeyAlgorithms['SLH-DSA-SHAKE-F']]: { kind: 'choice', options: [128, 192, 256], fallback: 128 },
	[KeyAlgorithms.Falcon]: { kind: 'choice', options: [512, 1024], fallback: 512 },
};

/**
 * `Map`s rather than indexes into the objects above: the lookup key is a free-form string off a DB row, and only `Map.get` is honest about a `key_type` this build has never heard of.
 */
const KEY_ALGORITHM_LABELS: ReadonlyMap<string, string> = new Map(KEY_ALGORITHM_ENTRIES.map(([label, value]) => [value.toLowerCase(), label]));
const KEY_SIZE_RULES_BY_TYPE: ReadonlyMap<string, KeySizeRule> = new Map(Object.entries(KEY_SIZE_RULES));

/**
 * Display name for a stored `key_type`. Falls back to the raw value so an algorithm added to the enum after this row was written still renders as something.
 */
export function keyAlgorithmLabel(keyType: string): string {
	return KEY_ALGORITHM_LABELS.get(keyType.toLowerCase()) ?? keyType;
}

export function keySizeRule(keyType: string): KeySizeRule {
	return KEY_SIZE_RULES_BY_TYPE.get(keyType.toLowerCase()) ?? { kind: 'none' };
}

/**
 * Clamp a submitted size onto what the algorithm accepts, so a stale form (or a hand-rolled POST) can't persist a size `dataKeyRotation` would silently ignore.
 *
 * Returns `null` for algorithms that take no size - which is exactly what the column should hold for them.
 */
export function normalizeKeySize(keyType: string, size: number | null | undefined): number | null {
	const rule = keySizeRule(keyType);

	switch (rule.kind) {
		case 'none':
			return null;
		case 'choice':
			return size !== null && size !== undefined && rule.options.includes(size) ? size : rule.fallback;
		case 'range':
			return size !== null && size !== undefined && Number.isInteger(size) && size >= rule.min && size <= rule.max && size % rule.step === 0 ? size : rule.fallback;
	}
}

/**
 * `AES-GCM · 256` / `Ed25519` - the key column of the keyrings table.
 */
export function describeKey(keyType: string, keySize: number | null): string {
	const label = keyAlgorithmLabel(keyType);
	return keySize === null ? label : `${label} · ${keySize}`;
}
