import type { CipherBitStrength } from 'helpers/ciphertext';
import { blobToBigInt } from 'helpers';
import { cipherText0Frame, cipherText0FrameSignedPayload, CipherTextFrameFlags, splitCipherText0Frame, type CipherText0Parts } from 'helpers/ciphertext';
import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, createHash, createHmac, createSecretKey, hkdf, randomBytes, timingSafeEqual, type CipherGCM, type CipherGCMOptions, type CipherKey, type DecipherGCM } from 'node:crypto';
import { promisify } from 'node:util';
import { AnalyticsSize, type DOJurisdictions } from 'types';
import { BitwardenCloudEndpoints, type SecretNote } from 'types/bw';
import { EncryptionAlgorithms } from 'types/crypto';
import type { TenantLogEventStatus, TenantLogEventType } from 'types/tenants/logging';
import { TenantLogQueueMessageSchema } from 'types/tenants/logging';
import { v7 as uuidv7 } from 'uuid';
import type * as zm from 'zod/mini';
import { openBitwardenSession } from '~/bitwarden-pool';
import type { ContextVariables, EnvVars } from '~/types';
import * as analyticsSchema from 'db/schemas/wae';
import * as tenantSchema from 'db/schemas/tenant/main';
import { desc, eq, sql } from 'drizzle-orm/sql';
import type { Context } from 'hono';
import { hexToUuid } from 'helpers';
import type { TenantByoBwNoteSchema } from 'db';

const hkdfAsync = promisify(hkdf);

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type CryptoContext = Context<{ Bindings: EnvVars; Variables: ContextVariables }, string, {}>;

/**
 * A tenant keyring the caller is permitted to run this operation against, resolved from `c.var.permissions` by name. Carries the base64url keyring id (the permission map's key) alongside the retrieval/generation window sizes that bound which data key versions an operation may touch.
 */
export interface ResolvedKeyring {
	kr_id_base64url: string;
	kr_id_hex: string;
	kr_name: string;
	generation_versions: number;
	retreival_versions: number;
}

/**
 * Find the caller's permission entry for `keyringName` and confirm it grants `need` (`r_encrypt`/`r_decrypt`). Case-insensitive on the name, `timingSafeEqual` on equal-length names so a lookup can't be turned into a timing oracle for other tenants' keyring names.
 *
 * Returns `null` for both "no such keyring in this token's grants" and "found but not permitted" - the caller turns either into a 403, so the two are deliberately indistinguishable to the client.
 */
export function resolveKeyring(c: CryptoContext, keyringName: string, need: 'r_encrypt' | 'r_decrypt'): ResolvedKeyring | null {
	const wanted = Buffer.from(keyringName.trim().toLowerCase());

	for (const [kr_id_base64url, permission] of Object.entries(c.var.permissions)) {
		const candidate = Buffer.from(permission.kr_name.toLowerCase());
		if (candidate.byteLength === wanted.byteLength && timingSafeEqual(candidate, wanted) && permission[need]) {
			return {
				kr_id_base64url,
				kr_id_hex: Buffer.from(kr_id_base64url, 'base64url').toString('hex'),
				kr_name: permission.kr_name,
				generation_versions: permission.generation_versions,
				retreival_versions: permission.retreival_versions,
			};
		}
	}

	return null;
}

/**
 * One data key of a keyring, joined with the keyring metadata needed to rebuild its key material, and already converted out of the raw blob columns.
 */
export interface DatakeyRow {
	dk_id_hex: string;
	kr_id_hex: string;
	bw_id_hex: string | null;
	generation_count: bigint;
	key_size: number | null;
	hash: typeof tenantSchema.keyrings.$inferSelect.hash;
}

/**
 * A data key with its actual (decrypted) key material pulled from Bitwarden - the private JWK plus the optional public JWK, HKDF salt and MAC info that {@link deriveKeys} needs.
 */
export interface DatakeyMaterial extends DatakeyRow {
	privateJwk: JsonWebKey;
	publicJwk?: JsonWebKey;
	salt: Buffer;
	macInfo: Buffer;
}

/**
 * The newest `limit` data keys of one keyring, newest first. Ordered by `dk_id` descending because `dk_id` is a UUIDv7 (time-ordered) and the `datakeys` table carries no `b_time` column - the same ordering `keyrings/list` relies on.
 *
 * `limit` is the operation's version window: `generation_versions + 1` for encrypt (which only ever uses the first, newest row) and `retreival_versions + 1` for decrypt (which must confirm the ciphertext's own data key falls inside it).
 */
export async function fetchDatakeys(c: CryptoContext, kr_id_hex: string, limit: number): Promise<DatakeyRow[]> {
	return c.var.t_db
		.select({
			dk_id: tenantSchema.datakeys.dk_id,
			kr_id: tenantSchema.datakeys.kr_id,
			bw_id: tenantSchema.datakeys.bw_id,
			generation_count: tenantSchema.datakeys.generation_count,
			key_size: tenantSchema.keyrings.key_size,
			hash: tenantSchema.keyrings.hash,
		})
		.from(tenantSchema.datakeys)
		.innerJoin(tenantSchema.keyrings, eq(tenantSchema.keyrings.kr_id, tenantSchema.datakeys.kr_id))
		.where(eq(tenantSchema.datakeys.kr_id, sql`unhex(${kr_id_hex})`))
		.orderBy(desc(tenantSchema.datakeys.dk_id))
		.limit(limit)
		.then((rows) =>
			rows.map((row) => ({
				dk_id_hex: row.dk_id.toString('hex'),
				kr_id_hex: row.kr_id.toString('hex'),
				bw_id_hex: row.bw_id ? row.bw_id.toString('hex') : null,
				generation_count: blobToBigInt(row.generation_count) ?? BigInt(0),
				key_size: row.key_size,
				hash: row.hash,
			})),
		);
}

function rootEndpoints(jurisdiction: DOJurisdictions | null) {
	return {
		base: jurisdiction === ('eu' as DOJurisdictions) ? BitwardenCloudEndpoints.Api.eu : BitwardenCloudEndpoints.Api.us,
		authentication: jurisdiction === ('eu' as DOJurisdictions) ? BitwardenCloudEndpoints.Identity.eu : BitwardenCloudEndpoints.Identity.us,
	};
}

/**
 * The subset of tenant properties an encrypt/decrypt request needs: where its data keys' Bitwarden secrets live (`byo_bw`), and whether it may contribute to anonymized platform analytics. Read once per request from the tenant's Durable Object and threaded through the operation.
 */
export interface OperationTenantProperties {
	byo_bw: string | null;
	platform_analytics: boolean | null;
}

/**
 * The tenant's own Durable Object stub, addressed through its jurisdiction when it has one - exactly as `base.ts` builds the tenant DB handle (jurisdictional namespace + `idFromString`).
 */
function tenantStub(c: CryptoContext) {
	const namespace = c.var.t_jurisdiction ? c.env.TENANT_D0.jurisdiction(c.var.t_jurisdiction) : c.env.TENANT_D0;
	return c.env.TENANT_D0.get(namespace.idFromString(c.var.t_do_id));
}

/**
 * Read the tenant's `byo_bw` and `platform_analytics` properties from its Durable Object.
 */
export async function fetchTenantProperties(c: CryptoContext): Promise<OperationTenantProperties> {
	const properties = await tenantStub(c).getProperties({ byo_bw: true, platform_analytics: true });

	return {
		byo_bw: properties.byo_bw ?? null,
		platform_analytics: properties.platform_analytics ?? null,
	};
}

/**
 * Hydrate `datakeys` with their decrypted key material from Bitwarden, mirroring how `DataKeyRotation` stored them: the secret's `value` is the private JWK JSON, its `note` is `{ public?, salt, macInfo }` (both base64url). Keys live in the tenant's own vault when it has a `byo_bw` connection configured, otherwise in our managed organization for its jurisdiction - the same selection `DataKeyRotation` makes when writing them.
 *
 * Sessions are borrowed from the tenant's pool (never opened raw, never `nuke()`d here). Secrets are matched back to their data key by Bitwarden id, so a secret this token can't decrypt (in the managed vault the listing can span tenants) simply drops out.
 */
export async function loadDatakeyMaterial(c: CryptoContext, datakeys: DatakeyRow[], byo_bw: string | null): Promise<DatakeyMaterial[]> {
	const withBw = datakeys.filter((dk): dk is DatakeyRow & { bw_id_hex: string } => dk.bw_id_hex !== null);
	if (withBw.length === 0) return [];

	const jurisdiction = c.var.t_jurisdiction;
	const rootAccessToken = jurisdiction === ('eu' as DOJurisdictions) ? c.env.EU_BW_SM_ACCESS_TOKEN : c.env.US_BW_SM_ACCESS_TOKEN;

	const rootStub = await openBitwardenSession(c.env, {
		jurisdiction,
		t_do_id_hex: c.var.t_do_id,
		log_t_id_hex: c.var.t_id.hex,
		u_id: null,
		ak_id: c.var.ak_id.hex,
		endpoints: rootEndpoints(jurisdiction),
		accessToken: rootAccessToken,
	});

	// Where the data keys' secrets actually live: the tenant's own vault when a BYO connection is set, our managed organization otherwise - decided the same way `DataKeyRotation` decides where to write them.
	let vaultStub = rootStub;
	let vaultToken = rootAccessToken;

	if (byo_bw) {
		const [connection] = await rootStub.getSecrets([byo_bw.toLowerCase()]);
		if (connection) {
			const note = JSON.parse(await decryptOne(rootStub, rootAccessToken, connection.note)) as zm.output<typeof TenantByoBwNoteSchema>;
			vaultToken = await decryptOne(rootStub, rootAccessToken, connection.value);
			vaultStub = await openBitwardenSession(c.env, {
				jurisdiction,
				t_do_id_hex: c.var.t_do_id,
				log_t_id_hex: c.var.t_id.hex,
				u_id: null,
				ak_id: c.var.ak_id.hex,
				endpoints: note.endpoints,
				accessToken: vaultToken,
			});
		}
	}

	const secrets = await vaultStub.getSecrets(withBw.map((dk) => hexToUuid(dk.bw_id_hex).toLowerCase()));

	return Promise.all(
		secrets.map(async (secret): Promise<DatakeyMaterial | undefined> => {
			const datakey = withBw.find((dk) => dk.bw_id_hex === secret.id.replaceAll('-', ''));
			if (!datakey) return undefined;

			const [value, note] = await Promise.all([decryptOne(vaultStub, vaultToken, secret.value), decryptOne(vaultStub, vaultToken, secret.note)]);
			const parsedNote = JSON.parse(note) as SecretNote;

			return {
				...datakey,
				privateJwk: JSON.parse(value) as JsonWebKey,
				...(parsedNote.public && { publicJwk: parsedNote.public }),
				salt: Buffer.from(parsedNote.salt, 'base64url'),
				macInfo: Buffer.from(parsedNote.macInfo, 'base64url'),
			};
		}),
	).then((rows) => rows.filter((row): row is DatakeyMaterial => row !== undefined));
}

/**
 * `decryptSecret`'s RPC signature collapses to the last overload, whose `iv` is the literal `true`; the implementation takes `iv?: boolean` and returns the plain string for anything falsy, so `false` is the right runtime value even though the type can't say so. Mirrors `wf/vaultMigration.ts`.
 */
function decryptOne(stub: Awaited<ReturnType<typeof openBitwardenSession>>, accessToken: string, cipherText: string): Promise<string> {
	return stub.decryptSecret(accessToken, cipherText, false as true) as unknown as Promise<string>;
}

/**
 * Every `keyrings.hash` catalog value normalized to the SHA family name `node:crypto` uses for HKDF/HMAC. The weak digests the catalog also lists (`md4`, `md5`, `md5-sha1`, `RSA-MD5`) are rejected rather than silently used to key derivation.
 */
export function normalizeHash(hash: DatakeyRow['hash']): 'sha1' | 'sha224' | 'sha256' | 'sha384' | 'sha512' {
	switch (hash) {
		case 'sha1':
		case 'RSA-SHA1':
		case 'DSA-SHA':
		case 'DSA-SHA1':
		case 'ecdsa-with-SHA1':
			return 'sha1';
		case 'sha224':
		case 'RSA-SHA224':
			return 'sha224';
		case 'sha256':
		case 'RSA-SHA256':
			return 'sha256';
		case 'sha384':
		case 'RSA-SHA384':
			return 'sha384';
		case 'sha512':
		case 'RSA-SHA512':
			return 'sha512';
		default:
			throw new Error(`Unsupported hash "${hash}" for key derivation`);
	}
}

/**
 * The algorithms whose key size is not the caller's to pick, and which therefore carry no `bitStrength` anywhere: not on the request, not in the ciphertext header, not in the audit row. ChaCha20-Poly1305 is defined over a 256-bit key and nothing else, so a strength would be a number nobody chose and a field nobody can vary.
 */
const FIXED_KEY_ALGORITHMS = new Set<EncryptionAlgorithms>([EncryptionAlgorithms['ChaCha20-Poly1305']]);

/**
 * How many bytes of cipher key an algorithm runs on. The one place the fixed-size algorithms' key length is written down, since they no longer carry a `bitStrength` to derive it from.
 */
export function cipherKeyBytes(algorithm: EncryptionAlgorithms, bitStrength?: CipherBitStrength): number {
	if (algorithm === EncryptionAlgorithms['ChaCha20-Poly1305']) return 32;
	if (bitStrength === undefined) throw new Error(`${algorithm} requires an explicit bitStrength`);
	return parseInt(bitStrength, 10) / 8;
}

/**
 * The key strength an operation records, which for a fixed-key algorithm is none at all.
 *
 * Throws when a fixed-key algorithm is handed a strength, rather than ignoring it: a ciphertext header claiming e.g. 128-bit ChaCha20-Poly1305 is malformed, and accepting it would let the same bytes be described two ways. For the algorithms that do take a choice, the choice is required.
 */
export function resolveBitStrength(algorithm: EncryptionAlgorithms, requested?: CipherBitStrength): CipherBitStrength | undefined {
	if (FIXED_KEY_ALGORITHMS.has(algorithm)) {
		if (requested !== undefined) throw new Error(`${algorithm} has no configurable key strength; omit bitStrength`);
		return undefined;
	}

	if (requested === undefined) throw new Error(`${algorithm} requires an explicit bitStrength`);
	return requested;
}

/**
 * The digests recorded alongside every encrypt/decrypt audit row, so a tenant can tie a logged operation back to the exact content it ran on without that content ever being stored.
 *
 * All six are emitted because callers already hold their payload under whichever digest their own systems use; computing them here saves a tenant re-hashing to match. Note this is deliberately a fingerprint of the plaintext: it lets anyone who can read the audit log *confirm* a guessed payload, so it is content-traceability bought at the cost of that confirmation oracle - which is why it is the plaintext digest and never the plaintext.
 */
export const PLAINTEXT_DIGEST_ALGORITHMS = ['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512'] as const;
export type PlaintextDigests = Record<(typeof PLAINTEXT_DIGEST_ALGORITHMS)[number], string>;

/**
 * Runs every {@link PLAINTEXT_DIGEST_ALGORITHMS} digest over a payload at once, incrementally - so the streaming paths can fingerprint a file they never hold in full.
 */
export class PlaintextDigester {
	private readonly hashes = PLAINTEXT_DIGEST_ALGORITHMS.map((algorithm) => ({ algorithm, hash: createHash(algorithm) }));

	update(bytes: Uint8Array): void {
		if (bytes.byteLength === 0) return;
		for (const { hash } of this.hashes) hash.update(bytes);
	}

	digest(): PlaintextDigests {
		return Object.fromEntries(this.hashes.map(({ algorithm, hash }) => [algorithm, hash.digest('hex')])) as PlaintextDigests;
	}
}

/**
 * The name a raw-body upload calls itself, from `X-Filename` if the caller set one and otherwise from the `Content-Disposition` request header - the standard place a filename travels when the body is the file rather than a form part.
 *
 * RFC 5987's `filename*` is preferred over plain `filename` when both are present, since only the former can carry non-ASCII. Returns `fallback` when neither header names anything usable.
 */
export function uploadFilename(c: CryptoContext, fallback: string): string {
	const explicit = sanitizeFilename(c.req.header('X-Filename'));
	if (explicit) return explicit;

	const disposition = c.req.header('Content-Disposition');
	if (!disposition) return fallback;

	const extended = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(disposition)?.[1];
	if (extended) {
		// A malformed percent-escape throws rather than decodes, and a bad header should not fail an otherwise valid upload
		let decoded: string | undefined;
		try {
			decoded = decodeURIComponent(extended.trim());
		} catch {
			decoded = undefined;
		}
		const fromExtended = sanitizeFilename(decoded);
		if (fromExtended) return fromExtended;
	}

	const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(disposition);
	return sanitizeFilename(plain?.[1] ?? plain?.[2]) ?? fallback;
}

/**
 * Reduce a caller-supplied filename to something safe to echo into a `Content-Disposition` response header and into an audit row.
 *
 * Directory components are dropped (both separators, so a Windows path cannot smuggle one through), as are control characters - a bare CR or LF would otherwise split the response headers. `.` and `..` name nothing usable. Returns `undefined` when nothing survives, so callers fall through to their own default.
 */
function sanitizeFilename(raw: string | undefined): string | undefined {
	if (!raw) return undefined;

	const cleaned = raw
		.split(/[/\u005c]/)
		.pop()
		// eslint-disable-next-line no-control-regex
		?.replace(/[\u0000-\u001f\u007f"\u005c]/g, '')
		.trim();
	if (!cleaned || cleaned === '.' || cleaned === '..') return undefined;

	// Long enough for any real name, short enough that the header stays sane
	return cleaned.slice(0, 200);
}

/**
 * {@link PlaintextDigester} over a payload already held in memory - the buffered JSON paths.
 */
export function digestPlaintext(input: Uint8Array): PlaintextDigests {
	const digester = new PlaintextDigester();
	digester.update(input);
	return digester.digest();
}

/**
 * The byte length of a node digest's output - the size of the MAC keyed by that hash, which the streaming decrypt parser needs to know how many trailing characters are the signature.
 */
export function hashByteLength(nodeHash: string): number {
	return createHash(nodeHash).digest().byteLength;
}

/**
 * The `node:crypto` cipher name for an algorithm + bit strength (`aes-256-gcm`, `chacha20-poly1305`, ...). Also what the anonymized `EAAS_PLATFORM_ANALYTICS.algorithm` column records, so it must stay a value from `workersCryptoCatalog.ciphers`.
 */
export function nodeCipherName(algorithm: EncryptionAlgorithms, bitStrength?: CipherBitStrength): string {
	switch (algorithm) {
		case EncryptionAlgorithms['AES-CBC']:
			return `aes-${bitStrength}-cbc`;
		case EncryptionAlgorithms['AES-CTR']:
			return `aes-${bitStrength}-ctr`;
		case EncryptionAlgorithms['AES-GCM']:
			return `aes-${bitStrength}-gcm`;
		case EncryptionAlgorithms['ChaCha20-Poly1305']:
			return 'chacha20-poly1305';
	}
}

/**
 * Bytes of preamble (IV / counter block / nonce) an algorithm needs alongside the key - fixed per algorithm, which is what lets the ciphertext carry it without a length prefix.
 */
export function preambleLength(algorithm: EncryptionAlgorithms): number {
	switch (algorithm) {
		case EncryptionAlgorithms['AES-GCM']:
		case EncryptionAlgorithms['ChaCha20-Poly1305']:
			// 96-bit nonce
			return 12;
		case EncryptionAlgorithms['AES-CBC']:
		case EncryptionAlgorithms['AES-CTR']:
			// 128-bit IV / counter block
			return 16;
	}
}

/**
 * Reject a ciphertext whose preamble is not the exact width its own algorithm fixes. {@link cipherText0FrameSignedPayload} is unambiguous only because that width is a function of the algorithm, so a preamble of any other length is a framing error rather than something to hand to the cipher.
 *
 * `createCipheriv`/`createDecipheriv` enforce the length themselves for the AES modes, but not uniformly - GCM accepts any non-empty IV - so the check is made here, once, for every path.
 */
export function assertPreambleLength(algorithm: EncryptionAlgorithms, preamble: Uint8Array): void {
	const expected = preambleLength(algorithm);
	if (preamble.byteLength !== expected) throw new Error(`${algorithm} expects a ${expected}-byte preamble, received ${preamble.byteLength}`);
}

/**
 * Whether the algorithm is an AEAD (its ciphertext carries a 16-byte authentication tag appended after the cipher body).
 */
export function isAead(algorithm: EncryptionAlgorithms): boolean {
	return algorithm === EncryptionAlgorithms['AES-GCM'] || algorithm === EncryptionAlgorithms['ChaCha20-Poly1305'];
}

/**
 * The `node:crypto` cipher options for an algorithm: the AEAD tag length for GCM/ChaCha20-Poly1305, otherwise nothing. Typed as {@link CipherGCMOptions} (not an inline literal) so it is accepted by the generic string-algorithm `createCipheriv`/`createDecipheriv` overload, which only sees `stream.TransformOptions`.
 */
export function cipherOptions(algorithm: EncryptionAlgorithms): CipherGCMOptions | undefined {
	return isAead(algorithm) ? { authTagLength: AEAD_TAG_LENGTH } : undefined;
}

/**
 * Length in bytes of the authentication tag AEAD ciphers append. Only meaningful when {@link isAead}.
 */
export const AEAD_TAG_LENGTH = 16;

/**
 * A stable, key-sorted JSON serialization, so the derived key material is deterministic regardless of the member order a JWK happens to be stored/parsed in.
 */
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
	return `{${Object.keys(value as Record<string, unknown>)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
		.join(',')}}`;
}

/**
 * Derive the operation's cipher key and MAC key from a data key's stored JWK material, via HKDF.
 *
 * The input keying material is the private JWK (and the public one when present) canonicalized to bytes - deterministic across encrypt and decrypt because both read the same stored secret. Two independent HKDF expansions off the same IKM and salt: the cipher key at the algorithm's key length with {@link nodeCipherName} as `info`, the MAC key at the hash's own output length with the data key's `macInfo` as `info`, so the two keys can never collide. This mirrors the pre-rearchitecture derivation, minus its `exportKey('raw')` step (which WebCrypto rejects for RSA/EC private keys).
 *
 * The cipher's own name is the `info` rather than nothing, so every `(algorithm, bitStrength)` pair gets its own key. HKDF-Expand is a byte stream: with one shared `info` the only thing separating the variants is output length, which makes the 128-bit key a prefix of the 256-bit one and makes ChaCha20-Poly1305's key byte-identical to AES-256's. Domain separation keeps a key recovered against one cipher from being the key that protects another.
 */
export async function deriveKeys(material: Pick<DatakeyMaterial, 'privateJwk' | 'publicJwk' | 'salt' | 'macInfo' | 'hash'>, algorithm: EncryptionAlgorithms, bitStrength?: CipherBitStrength): Promise<{ cipherKey: CipherKey; macKey: CipherKey }> {
	// The MAC key's separation from the cipher key rests entirely on `macInfo` differing from the cipher's `info`; an empty one would put that guarantee back on output length alone
	if (material.macInfo.byteLength === 0) throw new Error('Data key is missing its MAC info; key derivation cannot separate the cipher and MAC keys');

	const nodeHash = normalizeHash(material.hash);

	const ikm = Buffer.concat([Buffer.from(stableStringify(material.privateJwk), 'utf8'), ...(material.publicJwk ? [Buffer.from(stableStringify(material.publicJwk), 'utf8')] : [])]);

	const [cipherKey, macKey] = await Promise.all([hkdfAsync(nodeHash, ikm, material.salt, Buffer.from(nodeCipherName(algorithm, bitStrength), 'utf8'), cipherKeyBytes(algorithm, bitStrength)).then((key) => Buffer.from(key)), hkdfAsync(nodeHash, ikm, material.salt, material.macInfo, createHash(nodeHash).digest().byteLength).then((key) => Buffer.from(key))]);

	return { cipherKey: createSecretKey(cipherKey), macKey };
}

/**
 * Constant-time compare of two byte strings of possibly different length (`timingSafeEqual` throws on a length mismatch), for verifying a ciphertext's MAC.
 */
export function macEqual(a: Uint8Array, b: Uint8Array): boolean {
	return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

/**
 * How much plaintext one frame covers. The encoder's choice alone - frames are self-delimiting on the wire, so a reader never needs to agree on the number and an older ciphertext keeps decrypting if this changes.
 *
 * 64 KiB is the trade: it is the working-set size a decrypt holds before it can verify and release, and the MAC per frame costs `hashLength / 65536` (0.05% for SHA-256), so raising it saves almost nothing and lowering it costs latency to the first released byte.
 */
export const CIPHERTEXT_FRAME_PLAINTEXT_BYTES = 64 * 1024;

/**
 * The shared half of the framing work: the cipher and MAC key, and the header the frames are anchored to.
 */
interface FrameContext {
	algorithm: EncryptionAlgorithms;
	bitStrength?: CipherBitStrength;
	cipherKey: CipherKey;
	macKey: CipherKey;
	nodeHash: string;
	dk_id_hex: string;
}

/**
 * Turn a plaintext stream into {@link CipherTextVersions.dkKrPreambleFramedCipher} frames.
 *
 * One cipher runs for the whole message - the frames are consecutive slices of its output, not separately keyed messages - so there is no per-frame nonce to derive and the preamble keeps its single-use-per-message meaning. What each frame gets of its own is an HMAC over its index, its final flag and its cipher bytes, which is what lets the other side authenticate it in isolation.
 *
 * For an AEAD the cipher's own authentication tag is appended to the final frame's cipher bytes and so falls under that frame's MAC too. It is redundant by then - if every frame's MAC verified, the tag cannot fail - but it keeps the cipher's output complete rather than discarding part of it.
 */
export class CipherTextFramer {
	private readonly cipher;
	private readonly pending: Buffer[] = [];
	private pendingBytes = 0;
	private index = 0;
	private done = false;

	readonly preamble: Buffer;

	constructor(private readonly context: FrameContext) {
		this.preamble = randomBytes(preambleLength(context.algorithm));
		this.cipher = createCipheriv(nodeCipherName(context.algorithm, context.bitStrength), context.cipherKey, this.preamble, cipherOptions(context.algorithm));
	}

	private seal(flag: CipherTextFrameFlags, cipher: Buffer): Uint8Array {
		const { algorithm, bitStrength, macKey, nodeHash, dk_id_hex } = this.context;
		const mac = createHmac(nodeHash, macKey)
			.update(cipherText0FrameSignedPayload({ dk_id_hex, algorithm, bitStrength, preamble: new Uint8Array(this.preamble), index: this.index++, flag, cipher: new Uint8Array(cipher) }))
			.digest();

		return cipherText0Frame(flag, new Uint8Array(cipher), new Uint8Array(mac));
	}

	/**
	 * Feed plaintext in; take back however many whole frames that completed (often none).
	 */
	push(plaintext: Uint8Array): Uint8Array[] {
		if (this.done) throw new Error('Framer already finished');
		if (plaintext.byteLength === 0) return [];

		this.pending.push(Buffer.from(plaintext));
		this.pendingBytes += plaintext.byteLength;
		if (this.pendingBytes < CIPHERTEXT_FRAME_PLAINTEXT_BYTES) return [];

		let buffered = Buffer.concat(this.pending.splice(0), this.pendingBytes);
		const frames: Uint8Array[] = [];

		while (buffered.byteLength >= CIPHERTEXT_FRAME_PLAINTEXT_BYTES) {
			const out = this.cipher.update(buffered.subarray(0, CIPHERTEXT_FRAME_PLAINTEXT_BYTES));
			buffered = buffered.subarray(CIPHERTEXT_FRAME_PLAINTEXT_BYTES);
			// A block cipher can hold bytes back across an update; an empty frame would carry nothing but its own MAC, so let the next one take them
			if (out.byteLength > 0) frames.push(this.seal(CipherTextFrameFlags.continues, out));
		}

		this.pending.push(buffered);
		this.pendingBytes = buffered.byteLength;

		return frames;
	}

	/**
	 * Close the message: whatever plaintext is still held, plus the cipher's own tail (CBC's padding block, an AEAD's tag), sealed as the frame flagged final.
	 */
	finish(): Uint8Array[] {
		if (this.done) throw new Error('Framer already finished');
		this.done = true;

		const buffered = Buffer.concat(this.pending.splice(0), this.pendingBytes);
		this.pendingBytes = 0;

		const tail = [buffered.byteLength > 0 ? this.cipher.update(buffered) : Buffer.alloc(0), this.cipher.final()];
		if (isAead(this.context.algorithm)) tail.push((this.cipher as CipherGCM).getAuthTag());

		return [this.seal(CipherTextFrameFlags.final, Buffer.concat(tail))];
	}
}

/**
 * The inverse of {@link CipherTextFramer}: authenticate each frame, and only then decrypt it.
 *
 * {@link push} verifies a frame's MAC against the position it actually arrived at before a single one of its bytes reaches the decipher, so nothing a caller receives is ever unverified - the property the un-framed format could not offer, since its one MAC only closed after the last byte had already been handed over. {@link finish} refuses a message that ended without a frame marked final, which is how a truncated stream is told apart from a complete one.
 */
export class CipherTextDeframer {
	private readonly decipher;
	private readonly macLength: number;
	private index = 0;
	private sawFinal = false;

	constructor(
		private readonly context: FrameContext,
		private readonly preamble: Uint8Array,
	) {
		assertPreambleLength(context.algorithm, preamble);
		this.macLength = hashByteLength(context.nodeHash);
		this.decipher = createDecipheriv(nodeCipherName(context.algorithm, context.bitStrength), context.cipherKey, Buffer.from(preamble), cipherOptions(context.algorithm));
	}

	/**
	 * Verify one frame and return the plaintext it carries. Throws - before decrypting anything - on a MAC mismatch, a frame arriving after the final one, or a malformed frame.
	 */
	push(frame: Uint8Array): Buffer {
		if (this.sawFinal) throw new Error('Invalid ciphertext - a frame follows the one marked final');

		const { algorithm, bitStrength, macKey, nodeHash, dk_id_hex } = this.context;
		const { flag, cipher, mac } = splitCipherText0Frame(frame, this.macLength);

		const expected = createHmac(nodeHash, macKey)
			.update(cipherText0FrameSignedPayload({ dk_id_hex, algorithm, bitStrength, preamble: this.preamble, index: this.index, flag, cipher }))
			.digest();
		if (!macEqual(new Uint8Array(expected), mac)) throw new Error(`Invalid signature on frame ${this.index} - ciphertext may have been tampered with`);

		this.index++;

		let body = Buffer.from(cipher);
		if (flag === CipherTextFrameFlags.final) {
			this.sawFinal = true;

			if (isAead(algorithm)) {
				if (body.byteLength < AEAD_TAG_LENGTH) throw new Error('Invalid ciphertext - final frame is missing its authentication tag');
				(this.decipher as DecipherGCM).setAuthTag(body.subarray(body.byteLength - AEAD_TAG_LENGTH));
				body = body.subarray(0, body.byteLength - AEAD_TAG_LENGTH);
			}
		}

		return this.decipher.update(body);
	}

	/**
	 * Close the message and return the decipher's own tail. Throws when no frame was marked final - the stream was cut short - and, for an AEAD, when the authentication tag does not check out.
	 */
	finish(): Buffer {
		if (!this.sawFinal) throw new Error('Invalid ciphertext - the stream ended before a frame marked final');
		return this.decipher.final();
	}
}

/**
 * Encrypt one in-memory buffer, buffered end to end - the JSON route's per-item path. Produces the full {@link CipherText0Parts}: a fresh random preamble and the message's frames, each carrying its own HMAC keyed by the derived MAC key.
 */
export function encryptBuffered(params: FrameContext & { input: Uint8Array }): CipherText0Parts {
	const { algorithm, bitStrength, dk_id_hex, input, ...rest } = params;

	const framer = new CipherTextFramer({ algorithm, bitStrength, dk_id_hex, ...rest });
	const frames = [...framer.push(input), ...framer.finish()];

	return { dk_id_hex, algorithm, bitStrength, preamble: new Uint8Array(framer.preamble), frames };
}

/**
 * Decrypt one parsed ciphertext, buffered end to end - the JSON route's per-item path. Every frame's HMAC is verified **before** its bytes are run through the key, and the message is rejected unless it ends on a frame marked final. Throws on a MAC mismatch, a truncated frame sequence, or an AEAD tag mismatch.
 */
export function decryptBuffered(params: FrameContext & { preamble: Uint8Array; frames: Uint8Array[] }): Buffer {
	const { preamble, frames, ...context } = params;

	const deframer = new CipherTextDeframer(context, preamble);

	return Buffer.concat([...frames.map((frame) => deframer.push(frame)), deframer.finish()]);
}

// Ascending byte ceilings for each AnalyticsSize bucket. Index i is the inclusive upper bound of bucket i; anything larger than the last falls into `4GiB+`.
const ANALYTICS_SIZE_CEILINGS: readonly number[] = [256, 1024, 4096, 16384, 65536, 131072, 262144, 524288, 1048576, 4194304, 16777216, 67108864, 134217728, 268435456, 536870912, 1073741824, 4294967296];

/**
 * The privacy-rounding bucket a plaintext byte length falls into - the value the anonymized `EAAS_PLATFORM_ANALYTICS.size` column records. Never the exact size.
 */
export function analyticsSizeBucket(byteLength: number): AnalyticsSize {
	const index = ANALYTICS_SIZE_CEILINGS.findIndex((ceiling) => byteLength <= ceiling);
	return index === -1 ? AnalyticsSize['4GiB+'] : index;
}

/**
 * Enqueue one tenant audit row for an encrypt/decrypt operation. Built the same way every other producer builds one (mint the UUIDv7 from the same `Date` as `timestamp`, pull `ray_id` off `CF-Ray`, `parseAsync` before sending), and handed to `waitUntil` so a slow queue never delays the response. One row goes out per operation, so this is a single `send` rather than a `sendBatch` of one.
 *
 * Every absent field is written as an explicit `null` rather than left off. A key that vanishes when a value is missing makes rows inconsistent to query and hides the difference between "not applicable" and "never recorded"; JSON also drops `undefined` silently, so an omitted key never reaches the log at all.
 *
 * `context` must never carry plaintext, ciphertext, or key material - only the operation's shape (algorithm, strength, cipher, item count, size bucket) and the plaintext digests.
 *
 * Failures are caught and logged rather than left to reject: an unhandled rejection inside `waitUntil` tears down the whole deferred batch, taking the analytics write and the generation-count bump with it. The audit row is lost either way, but the rest of the request's bookkeeping is not, and the reason ends up somewhere readable. Each row covers one operation, so it stays far below the 128 KiB a queue message may carry even with all six plaintext digests attached.
 */
export function emitOperationLog(
	c: CryptoContext,
	params: {
		event_type: TenantLogEventType;
		kr_id_hex?: string;
		dk_id_hex?: string;
		context: Record<string, unknown>;
		status: TenantLogEventStatus;
	},
): void {
	const now = new Date();
	const headers = c.req.raw.headers;

	const log: zm.input<typeof TenantLogQueueMessageSchema> = {
		t_id: c.var.t_id.hex,
		jurisdiction: c.var.t_jurisdiction,
		id: uuidv7({ msecs: now.getTime() }).replaceAll('-', ''),
		timestamp: now.toISOString(),
		event_type: params.event_type,
		context: params.context,
		ip: headers.get('CF-Connecting-IP'),
		user_agent: headers.get('User-Agent'),
		ray_id: headers.get('CF-Ray')?.split('-')[0] ?? null,
		// Encrypt/decrypt are always reached by an API key (they're bearer-authed, never a dashboard session)
		ak_id: c.var.ak_id.hex,
		kr_id: params.kr_id_hex ?? null,
		dk_id: params.dk_id_hex ?? null,
		status: params.status,
	};

	c.executionCtx.waitUntil(
		TenantLogQueueMessageSchema.parseAsync(log)
			.then((parsed) => c.env.LOGS.send(parsed, { contentType: 'json' }))
			.catch((error: unknown) => console.error('Failed to enqueue crypto operation audit log', error)),
	);
}

/**
 * Write one or more fully-anonymized operation points into `EAAS_PLATFORM_ANALYTICS` - no tenant identifier ever travels with them (see the dataset's schema doc). Skipped entirely when the platform-analytics binding is absent (dev) or the tenant has the setting off. Identical `(operation, cipher, size bucket)` tuples are collapsed into one point with a `count`, and the PoP is taken from the request's `cf.colo`.
 */
export function emitAnalytics(c: CryptoContext, operation: (typeof analyticsSchema.EAAS_PLATFORM_ANALYTICS.operation.enumValues)[number], points: { cipher: string; byteLength: number }[], platformAnalyticsEnabled: boolean): void {
	if (!c.env.PLATFORM_ANALYTICS) return;
	if (!platformAnalyticsEnabled) return;
	if (points.length === 0) return;

	const iata = (c.req.raw.cf as IncomingRequestCfProperties | undefined)?.colo ?? '';

	const collapsed = new Map<string, { cipher: string; size: AnalyticsSize; count: number }>();
	for (const point of points) {
		const size = analyticsSizeBucket(point.byteLength);
		const key = `${point.cipher}|${size}`;
		const existing = collapsed.get(key);
		if (existing) {
			existing.count++;
		} else {
			collapsed.set(key, { cipher: point.cipher, size, count: 1 });
		}
	}

	c.executionCtx.waitUntil(
		Promise.all(
			Array.from(collapsed.values()).map((point) =>
				c.var.a_db.insert(analyticsSchema.EAAS_PLATFORM_ANALYTICS).values({
					operation,
					algorithm: point.cipher as (typeof analyticsSchema.EAAS_PLATFORM_ANALYTICS.algorithm.enumValues)[number],
					iata,
					size: point.size,
					count: point.count,
				}),
			),
		).catch((error: unknown) => console.error('Failed to write platform analytics', error)),
	);
}

/**
 * Record that a data key was used, best-effort and off the response path.
 *
 * `by` is 1 for an encrypt, which generates under the key, and 0 for a decrypt, which only reads with it - a decrypt still moves `a_time` ("last time key was used") without advancing the counter that drives count-based rotation. The increment itself happens inside the Durable Object so the read and the write share one transaction; see `TenantD0.recordDatakeyUsage`.
 *
 * Handed to `waitUntil` because the operation has already succeeded and the bookkeeping must not delay the response, with failures logged rather than left to reject - an unhandled rejection there would take the rest of the deferred work down with it.
 */
export function recordDatakeyUsage(c: CryptoContext, dk_id_hex: string, by: number): void {
	c.executionCtx.waitUntil(
		tenantStub(c)
			.recordDatakeyUsage(dk_id_hex, by)
			.catch((error: unknown) => console.error('Failed to record datakey usage', error)),
	);
}
