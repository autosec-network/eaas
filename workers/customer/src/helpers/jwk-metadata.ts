import { Buffer } from 'node:buffer';
import { KeyAlgorithms } from 'types/crypto';
import type { workersCryptoCatalog } from 'types/crypto/catalog';

type Hash = (typeof workersCryptoCatalog.hashes)[number];

/**
 * The handful of JWK members this platform's keys are described by. Deliberately narrower than `node:crypto`'s `JsonWebKey`, whose index signature makes every member untyped, and which doesn't know about the `AKP` key type the post-quantum JWKs use.
 */
export interface Jwk {
	kty?: string;
	alg?: string;
	crv?: string;
	/** RSA modulus, base64url */
	n?: string;
	/** Symmetric key material, base64url */
	k?: string;
	key_ops?: string[];
}

/**
 * The keyring columns that can be recovered from a datakey's stored key material alone.
 */
export interface KeyringMetadata {
	key_type: KeyAlgorithms;
	/**
	 * `null` whenever the algorithm doesn't take one, or whenever {@link JwkMetadata.describe} deliberately leaves it out so `dataKeyRotation`'s hash-driven defaults pick the size instead — see the AES note in {@link JwkMetadata.fromOct}.
	 */
	key_size: number | null;
	hash: Hash;
}

/**
 * Reverses `wf/dataKeyRotation.ts`'s key generation: given a datakey's JWK (plus the salt stored alongside it), work out which `keyrings` row would have produced it.
 *
 * This is inherently lossy — a JWK records what a key *is*, not the settings it was generated from — so everything here is a best-effort reconstruction, and the round-trip is only guaranteed for the fields `dataKeyRotation` actually reads back (`key_type`, `key_size`, `hash`).
 */
export class JwkMetadata {
	/**
	 * `dataKeyRotation` sizes a keyring's salt/macInfo as `randomBytes(createHash(hash).digest().byteLength)`, so the salt's length names the hash exactly — far more faithful than guessing from the JWK, which only ever carries the hash for RSA and HMAC.
	 */
	private static readonly hashByDigestLength = {
		16: 'md5',
		20: 'sha1',
		28: 'sha224',
		32: 'sha256',
		36: 'md5-sha1',
		48: 'sha384',
		64: 'sha512',
	} as const satisfies Record<number, Hash>;

	/**
	 * The inverse of `dataKeyRotation`'s "infer a key size from the hash" defaults, used for every algorithm whose JWK doesn't carry a hash of its own.
	 */
	private static hashForTier(tier: 'low' | 'mid' | 'high'): Hash {
		switch (tier) {
			case 'low':
				return 'sha256';
			case 'mid':
				return 'sha384';
			case 'high':
				return 'sha512';
		}
	}

	/**
	 * `RS256`/`PS384`/`HS512`/`RSA-OAEP-256` all end in the digest size of the hash they were generated with; a bare `RSA-OAEP` means SHA-1.
	 */
	private static hashFromAlg(alg?: string): Hash | undefined {
		if (!alg) return undefined;
		if (alg === 'RSA-OAEP') return 'sha1';

		switch (/(?:^|-)(1|224|256|384|512)$/.exec(alg)?.[1]) {
			case '1':
				return 'sha1';
			case '224':
				return 'sha224';
			case '256':
				return 'sha256';
			case '384':
				return 'sha384';
			case '512':
				return 'sha512';
			default:
				return undefined;
		}
	}

	private static byteLength(base64url?: string): number | undefined {
		return base64url ? Buffer.from(base64url, 'base64url').byteLength : undefined;
	}

	private static fromRsa(jwk: Jwk): Omit<KeyringMetadata, 'hash'> & { fallbackHash: Hash } {
		const key_type = jwk.alg?.startsWith('PS') ? KeyAlgorithms['RSA-PSS'] : jwk.alg?.startsWith('RSA-OAEP') ? KeyAlgorithms['RSA-OAEP'] : jwk.alg?.startsWith('RS') ? KeyAlgorithms['RSASSA-PKCS1-v1_5'] : jwk.key_ops?.some((op) => op === 'encrypt' || op === 'decrypt' || op === 'wrapKey' || op === 'unwrapKey') ? KeyAlgorithms['RSA-OAEP'] : KeyAlgorithms['RSASSA-PKCS1-v1_5'];
		const modulusBytes = JwkMetadata.byteLength(jwk.n);

		return {
			key_type,
			// `dataKeyRotation` feeds `key_size` straight to `modulusLength` whenever it's a multiple of 8, so the modulus's own bit length round-trips exactly
			key_size: modulusBytes ? modulusBytes * 8 : null,
			fallbackHash: JwkMetadata.hashFromAlg(jwk.alg) ?? 'sha256',
		};
	}

	private static fromEc(jwk: Jwk): (Omit<KeyringMetadata, 'hash'> & { fallbackHash: Hash }) | undefined {
		// Web Crypto omits `alg` on EC JWKs (the hash is chosen per-operation, not baked into the key), so the usages are the only signal for which of the two EC algorithms this is
		const key_type = jwk.key_ops?.some((op) => op === 'sign' || op === 'verify') ? KeyAlgorithms.ECDSA : KeyAlgorithms.ECDH;

		switch (jwk.crv) {
			case 'P-256':
				return { key_type, key_size: 256, fallbackHash: 'sha256' };
			case 'P-384':
				return { key_type, key_size: 384, fallbackHash: 'sha384' };
			case 'P-521':
				return { key_type, key_size: 521, fallbackHash: 'sha512' };
			default:
				return undefined;
		}
	}

	private static fromOkp(jwk: Jwk): (Omit<KeyringMetadata, 'hash'> & { fallbackHash: Hash }) | undefined {
		switch (jwk.crv) {
			case 'Ed25519':
				return { key_type: KeyAlgorithms.Ed25519, key_size: null, fallbackHash: 'sha512' };
			case 'X25519':
				return { key_type: KeyAlgorithms.X25519, key_size: null, fallbackHash: 'sha256' };
			default:
				return undefined;
		}
	}

	private static fromOct(jwk: Jwk): (Omit<KeyringMetadata, 'hash'> & { fallbackHash: Hash }) | undefined {
		if (jwk.alg?.startsWith('HS')) {
			return { key_type: KeyAlgorithms.HMAC, key_size: null, fallbackHash: JwkMetadata.hashFromAlg(jwk.alg) ?? 'sha256' };
		}

		const aes = /^A(128|192|256)(CBC|CTR|GCM|KW)$/.exec(jwk.alg ?? '');
		if (aes) {
			const bits = parseInt(aes[1]!, 10);
			const key_type = (() => {
				switch (aes[2]) {
					case 'CBC':
						return KeyAlgorithms['AES-CBC'];
					case 'CTR':
						return KeyAlgorithms['AES-CTR'];
					case 'GCM':
						return KeyAlgorithms['AES-GCM'];
					default:
						return KeyAlgorithms['AES-KW'];
				}
			})();

			return {
				key_type,
				/**
				 * Deliberately `null`. `dataKeyRotation`'s AES branch reads `key_size` as an input *tier* rather than a bit length (`256` → AES-128, `384` → AES-192, `521` → AES-256), so persisting the real bit length here would silently downgrade the key on the next rotation. Left empty, that branch falls through to its hash-driven defaults, which — paired with the `fallbackHash` below — regenerate this exact size.
				 */
				key_size: null,
				fallbackHash: JwkMetadata.hashForTier(bits === 128 ? 'low' : bits === 192 ? 'mid' : 'high'),
			};
		}

		return undefined;
	}

	/**
	 * The post-quantum JWKs `dataKeyRotation` hand-builds (`kty: 'AKP'`), where `alg` is the only field carrying the parameter set.
	 */
	private static fromAkp(jwk: Jwk): (Omit<KeyringMetadata, 'hash'> & { fallbackHash: Hash }) | undefined {
		const alg = jwk.alg ?? '';

		const mlKem = /^ML-KEM(512|768|1024)$/.exec(alg);
		if (mlKem) {
			const key_size = parseInt(mlKem[1]!, 10);
			return { key_type: KeyAlgorithms['ML-KEM'], key_size, fallbackHash: JwkMetadata.hashForTier(key_size === 512 ? 'low' : key_size === 768 ? 'mid' : 'high') };
		}

		const mlDsa = /^ML-DSA(44|65|87)$/.exec(alg);
		if (mlDsa) {
			const key_size = parseInt(mlDsa[1]!, 10);
			return { key_type: KeyAlgorithms['ML-DSA'], key_size, fallbackHash: JwkMetadata.hashForTier(key_size === 44 ? 'low' : key_size === 65 ? 'mid' : 'high') };
		}

		const slhDsa = /^SLH-DSA-(SHA2|SHAKE)-(128|192|256)-(S|F)$/.exec(alg);
		if (slhDsa) {
			const key_size = parseInt(slhDsa[2]!, 10);
			const key_type = (() => {
				switch (`${slhDsa[1]}-${slhDsa[3]}`) {
					case 'SHA2-S':
						return KeyAlgorithms['SLH-DSA-SHA2-S'];
					case 'SHA2-F':
						return KeyAlgorithms['SLH-DSA-SHA2-F'];
					case 'SHAKE-S':
						return KeyAlgorithms['SLH-DSA-SHAKE-S'];
					default:
						return KeyAlgorithms['SLH-DSA-SHAKE-F'];
				}
			})();

			return { key_type, key_size, fallbackHash: JwkMetadata.hashForTier(key_size === 128 ? 'low' : key_size === 192 ? 'mid' : 'high') };
		}

		const falcon = /^FN-DSA-(512|1024)$/.exec(alg);
		if (falcon) {
			const key_size = parseInt(falcon[1]!, 10);
			return { key_type: KeyAlgorithms.Falcon, key_size, fallbackHash: JwkMetadata.hashForTier(key_size === 512 ? 'low' : 'high') };
		}

		return undefined;
	}

	/**
	 * Work out the keyring settings behind a datakey.
	 *
	 * @param jwk The datakey's public JWK where it has one, otherwise its private JWK — symmetric algorithms only ever have the latter.
	 * @param saltBase64url The keyring's salt, as stored in the secret's note. Its length pins the hash down exactly; without it the hash is inferred from the JWK, which is only reliable for RSA and HMAC.
	 * @returns `undefined` when the JWK isn't one this platform generates.
	 */
	public static describe(jwk: Jwk, saltBase64url?: string): KeyringMetadata | undefined {
		const partial = (() => {
			switch (jwk.kty) {
				case 'RSA':
					return JwkMetadata.fromRsa(jwk);
				case 'EC':
					return JwkMetadata.fromEc(jwk);
				case 'OKP':
					return JwkMetadata.fromOkp(jwk);
				case 'oct':
					return JwkMetadata.fromOct(jwk);
				case 'AKP':
					return JwkMetadata.fromAkp(jwk);
				default:
					return undefined;
			}
		})();

		if (!partial) return undefined;

		const { fallbackHash, ...metadata } = partial;
		const saltLength = JwkMetadata.byteLength(saltBase64url);

		return {
			...metadata,
			hash: (saltLength !== undefined && saltLength in JwkMetadata.hashByDigestLength ? JwkMetadata.hashByDigestLength[saltLength as keyof typeof JwkMetadata.hashByDigestLength] : undefined) ?? fallbackHash,
		};
	}
}
