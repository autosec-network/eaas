import { Buffer } from 'node:buffer';
import { CipherTextVersions } from 'types/bw';
import { EncryptionAlgorithms } from 'types/crypto';
import { hexUuid7Regex } from 'types/zod/mini';
import * as zm from 'zod/mini';

/**
 * The text encodings a {@link CipherTextVersions.dkKrPreambleFramedCipher} ciphertext can be serialized in. Every segment of one ciphertext uses the same encoding, and {@link parseCipherText0} tells them apart by the length of the data key segment alone (a 16-byte UUID is 32 hex, 24 base64, or 22 base64url characters), so nothing else about the string has to announce which it is.
 */
export const CipherTextEncodings = ['base64', 'base64url', 'hex'] as const;
export type CipherTextEncoding = (typeof CipherTextEncodings)[number];

/**
 * Cipher key sizes, in bits, as the API takes them - strings, because they travel inside the ciphertext as text.
 */
export const CipherBitStrengths = ['128', '192', '256'] as const;
export type CipherBitStrength = (typeof CipherBitStrengths)[number];

/**
 * The leading byte of every frame: whether this is the last one. It is covered by the frame's own MAC, so a truncated stream cannot be passed off as a complete one - a reader that runs out of input without having seen a frame marked {@link CipherTextFrameFlags.final} rejects the message.
 */
export enum CipherTextFrameFlags {
	continues = 0,
	final = 1,
}

export interface CipherText0Parts {
	/**
	 * The data key the payload was encrypted under, as a hyphen-less lowercase hex UUIDv7 - the same shape `datakeys.dk_id` is fed through `unhex()`.
	 */
	dk_id_hex: string;
	algorithm: EncryptionAlgorithms;
	/**
	 * The cipher key size, for the algorithms that have a choice of one. Absent for the algorithms that do not: ChaCha20-Poly1305 is defined only over a 256-bit key, so there is nothing to record and its segment is written empty rather than carrying a number the caller never chose.
	 */
	bitStrength?: CipherBitStrength;
	/**
	 * Whatever the cipher needs alongside the key to run again: the IV for GCM/CBC, the initial counter block for CTR, the nonce for ChaCha20-Poly1305. Its length is fixed by {@link algorithm}, which is what keeps {@link cipherText0FrameSignedPayload} unambiguous without length prefixes.
	 *
	 * One preamble covers the whole message: the frames are consecutive slices of a single cipher run, not independently keyed messages, so there is no per-frame nonce to derive or to get wrong.
	 */
	preamble: Uint8Array;
	/**
	 * The frames, in order, each already assembled as `<final flag><cipher><mac>`. At least one is always present - an empty plaintext is a single final frame whose cipher segment is empty.
	 */
	frames: Uint8Array[];
}

/**
 * The textual header every frame's MAC is anchored to: `<version>.<dk_id hex>.<algorithm>.<bitStrength>`, the last empty for an algorithm with no choice of key size.
 *
 * Signing the header and not just the cipher bytes is what stops a ciphertext being re-addressed - swapped onto another data key, or re-labelled as a cipher that would decrypt the same bytes to something else. The header is fixed-format text (no `.` can appear in any of its four parts) and the preamble's length is a function of the algorithm named in it, so the concatenation parses one way only.
 */
export function cipherText0Header({ dk_id_hex, algorithm, bitStrength }: Pick<CipherText0Parts, 'dk_id_hex' | 'algorithm' | 'bitStrength'>): Uint8Array {
	return new Uint8Array(Buffer.from([CipherTextVersions.dkKrPreambleFramedCipher, dk_id_hex.toLowerCase(), algorithm, bitStrength ?? ''].join('.'), 'utf8'));
}

/**
 * The bytes one frame's MAC covers: the message header and preamble, then this frame's own position and final flag, then its cipher bytes.
 *
 * The index and the flag are what make the frames a sequence rather than a bag. Without the index a frame could be replayed at another position or two frames swapped; without the flag a stream could be cut short at any frame boundary and still verify. Both are inside the MAC, so neither can be edited by anyone without the MAC key.
 */
export function cipherText0FrameSignedPayload({ dk_id_hex, algorithm, bitStrength, preamble, index, flag, cipher }: Pick<CipherText0Parts, 'dk_id_hex' | 'algorithm' | 'bitStrength' | 'preamble'> & { index: number; flag: CipherTextFrameFlags; cipher: Uint8Array }): Uint8Array {
	const position = Buffer.alloc(8);
	position.writeBigUInt64BE(BigInt(index));

	return new Uint8Array(Buffer.concat([cipherText0Header({ dk_id_hex, algorithm, bitStrength }), Buffer.from(preamble), position, Buffer.from([flag]), Buffer.from(cipher)]));
}

/**
 * Assemble one frame's wire bytes from its parts - `<final flag><cipher><mac>`, the layout {@link splitCipherText0Frame} reads back.
 */
export function cipherText0Frame(flag: CipherTextFrameFlags, cipher: Uint8Array, mac: Uint8Array): Uint8Array {
	return new Uint8Array(Buffer.concat([Buffer.from([flag]), Buffer.from(cipher), Buffer.from(mac)]));
}

/**
 * Take one frame's wire bytes back apart, given the MAC width the data key's hash fixes. Throws when the frame is too short to hold both a flag and a MAC, or when its flag is not one of {@link CipherTextFrameFlags} - a framing problem either way, caught before any of it reaches a cipher.
 */
export function splitCipherText0Frame(frame: Uint8Array, macLength: number): { flag: CipherTextFrameFlags; cipher: Uint8Array; mac: Uint8Array } {
	if (frame.byteLength < 1 + macLength) throw new Error(`Invalid ciphertext frame: ${frame.byteLength} bytes cannot hold a flag and a ${macLength}-byte signature`);

	// Numeric enums carry a reverse mapping, so membership is the byte's own presence as a key - the same shape `ApiKeyVersions` is checked with
	const flag = frame[0] as CipherTextFrameFlags;
	if (!(flag in CipherTextFrameFlags)) throw new Error(`Invalid ciphertext frame flag ${frame[0]}`);

	return { flag, cipher: frame.subarray(1, frame.byteLength - macLength), mac: frame.subarray(frame.byteLength - macLength) };
}

/**
 * Serialize a version-`0` ciphertext: `0.<dk_id>.<algorithm>.<bitStrength>.<preamble>.<frame>.<frame>…`, every segment after the version in `outputFormat` (see {@link CipherTextVersions.dkKrPreambleFramedCipher}).
 *
 * `.` is the separator because none of the three encodings can produce one, so the string splits back apart without escaping - and because it makes each frame self-delimiting, which is what lets a streaming reader find a frame boundary without a length prefix to trust.
 */
export function cipherText0(outputFormat: CipherTextEncoding, { dk_id_hex, algorithm, bitStrength, preamble, frames }: CipherText0Parts): string {
	return [CipherTextVersions.dkKrPreambleFramedCipher, Buffer.from(dk_id_hex, 'hex').toString(outputFormat), Buffer.from(algorithm, 'utf8').toString(outputFormat), Buffer.from(bitStrength ?? '', 'utf8').toString(outputFormat), Buffer.from(preamble).toString(outputFormat), ...frames.map((frame) => Buffer.from(frame).toString(outputFormat))].join('.');
}

/**
 * Which of {@link CipherTextEncodings} a serialized data key segment is in, from its length alone - or `undefined` when it's none of them. Exposed so the streaming decrypt parser can read a ciphertext's encoding from just its header without materializing the whole string.
 */
export function detectCipherTextEncoding(dk_id_segment: string): CipherTextEncoding | undefined {
	return detectEncoding(dk_id_segment);
}

function detectEncoding(dk_id_segment: string): CipherTextEncoding | undefined {
	if (zm.safeParse(zm.hex().check(zm.length(32)), dk_id_segment).success) return 'hex';
	if (zm.safeParse(zm.base64().check(zm.length(24)), dk_id_segment).success) return 'base64';
	if (zm.safeParse(zm.base64url().check(zm.length(22)), dk_id_segment).success) return 'base64url';
	return undefined;
}

const nonEmptyBytesSchema = zm.instanceof(Uint8Array).check(zm.refine((bytes) => bytes.byteLength > 0, 'Segment is empty'));

/**
 * The structured form of a version-`0` ciphertext, as {@link parseCipherText0} hands it back - {@link CipherText0Parts} plus the encoding the string was found in, so a caller that wants to answer in kind can.
 *
 * A frame only has to be non-empty here. How much of it is flag, cipher and MAC depends on the data key's hash, which this side of the parse doesn't know - {@link splitCipherText0Frame} does that check once the key has been resolved.
 */
export const CipherText0PartsSchema = zm.object({
	encoding: zm.enum(CipherTextEncodings),
	dk_id_hex: zm.hex().check(zm.toLowerCase(), zm.length(32), zm.regex(hexUuid7Regex, 'Data key id is not a UUIDv7')),
	algorithm: zm.enum(EncryptionAlgorithms),
	bitStrength: zm.optional(zm.enum(CipherBitStrengths)),
	preamble: nonEmptyBytesSchema,
	frames: zm.array(nonEmptyBytesSchema).check(zm.minLength(1, 'Ciphertext carries no frames')),
});

/**
 * Split a serialized version-`0` ciphertext into {@link CipherText0PartsSchema} and validate its shape. Only the *shape* is checked - that the frames actually verify is the caller's job, since only the caller holds the key. Throws a `ZodError` (framing problem) on a malformed string.
 */
export function parseCipherText0(cipherText: string): Promise<zm.output<typeof CipherText0PartsSchema>> {
	const segments = cipherText.trim().split('.');
	// Version, the three header fields, the preamble, and at least one frame
	if (segments.length < 6) throw new Error(`Invalid ciphertext: expected at least 6 dot-separated segments, received ${segments.length}`);

	const [version, dk_id, algorithm, bitStrength, preamble, ...frames] = segments as [string, string, string, string, string, ...string[]];
	if (version !== String(CipherTextVersions.dkKrPreambleFramedCipher)) throw new Error(`Unsupported ciphertext version ${version}`);

	const encoding = detectEncoding(dk_id);
	if (!encoding) throw new Error('Invalid ciphertext: data key segment is not a base64, base64url, or hex encoded UUID');

	return CipherText0PartsSchema.parseAsync({
		encoding,
		dk_id_hex: Buffer.from(dk_id, encoding).toString('hex'),
		algorithm: Buffer.from(algorithm, encoding).toString('utf8'),
		// An empty segment is how an algorithm with no choice of key size records that it made none
		bitStrength: bitStrength.length > 0 ? Buffer.from(bitStrength, encoding).toString('utf8') : undefined,
		preamble: new Uint8Array(Buffer.from(preamble, encoding)),
		frames: frames.map((frame) => new Uint8Array(Buffer.from(frame, encoding))),
	});
}
