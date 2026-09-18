import type { CipherTextEncoding } from 'helpers/ciphertext';
import type { StreamingApi } from 'hono/utils/stream';
import { Buffer } from 'node:buffer';
import type { CipherKey } from 'node:crypto';
import type { EncryptionAlgorithms } from 'types/crypto';
import { CipherTextDeframer, CipherTextFramer, PlaintextDigester, type PlaintextDigests } from '~/v0/crypto/shared';

/**
 * The widest a single encoded frame segment may be before the stream is rejected.
 *
 * {@link CIPHERTEXT_FRAME_PLAINTEXT_BYTES} frames encode to roughly 128 KiB of hex, the widest of the three encodings, so this leaves well over an order of magnitude of headroom for a producer that framed more coarsely. Without a ceiling a body that simply never sends another `.` would be accumulated forever, which matters on a route that imposes no size limit of its own.
 */
const MAX_FRAME_CHARS = 4 * 1024 * 1024;

export interface StreamEncryptParams {
	algorithm: EncryptionAlgorithms;
	/** Absent for an algorithm with no choice of key size, such as ChaCha20-Poly1305. */
	bitStrength?: '128' | '192' | '256';
	encoding: CipherTextEncoding;
	cipherKey: CipherKey;
	macKey: CipherKey;
	nodeHash: string;
	dk_id_hex: string;
}

/**
 * Encrypt a file's bytes straight into the response as a streamed `cipherText0` string, holding only one frame in memory at a time.
 *
 * The five leading segments go out first, whole; then each frame as {@link CipherTextFramer} completes it, prefixed by the `.` that separates it from the last. Because a frame is encoded in one piece there is no partial-group carry to manage between writes - the frame boundary and the encoding boundary are the same boundary. Returns the plaintext byte count and digests for the caller's audit/analytics.
 */
export async function streamEncrypt(s: StreamingApi, params: StreamEncryptParams, chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<{ plaintextBytes: number; digests: PlaintextDigests }> {
	const { algorithm, bitStrength, encoding, cipherKey, macKey, nodeHash, dk_id_hex } = params;

	const framer = new CipherTextFramer({ algorithm, bitStrength, cipherKey, macKey, nodeHash, dk_id_hex });

	// Leading segments, each independently encoded. The frames that follow each bring their own separator.
	await s.write(['0', Buffer.from(dk_id_hex, 'hex').toString(encoding), Buffer.from(algorithm, 'utf8').toString(encoding), Buffer.from(bitStrength ?? '', 'utf8').toString(encoding), Buffer.from(framer.preamble).toString(encoding)].join('.'));

	const writeFrames = async (frames: Uint8Array[]): Promise<void> => {
		for (const frame of frames) await s.write(`.${Buffer.from(frame).toString(encoding)}`);
	};

	// Fingerprint the plaintext as it passes through, so the audit row can carry digests for a file that is never held in full
	const digester = new PlaintextDigester();
	let plaintextBytes = 0;

	// `for await` over a sync iterable is legal, so this one loop serves both a request body stream and an in-memory array of chunks
	for await (const chunk of chunks) {
		plaintextBytes += chunk.byteLength;
		digester.update(chunk);
		await writeFrames(framer.push(chunk));
	}

	await writeFrames(framer.finish());

	return { plaintextBytes, digests: digester.digest() };
}

export interface StreamDecryptParsedHeader {
	encoding: CipherTextEncoding;
	dk_id_hex: string;
	algorithm: EncryptionAlgorithms;
	/** Absent for an algorithm with no choice of key size, such as ChaCha20-Poly1305. */
	bitStrength?: '128' | '192' | '256';
	preamble: Uint8Array;
}

export interface StreamDecryptParams {
	header: StreamDecryptParsedHeader;
	cipherKey: CipherKey;
	macKey: CipherKey;
	nodeHash: string;
	/**
	 * The frame segments - everything after the fifth `.` - as string chunks. Consumed lazily, so this is the request body stream itself rather than a buffered copy of it.
	 */
	remainder: AsyncIterable<string> | Iterable<string>;
}

/**
 * Decrypt a streamed `cipherText0` straight into the response, holding one frame at a time.
 *
 * Each frame is authenticated by {@link CipherTextDeframer} before any of its bytes reach the decipher, so no unverified plaintext is ever written: a forged or tampered frame throws while the response still consists of frames that did verify, and the stream is aborted there rather than after the whole payload has been handed over. A message that ends without a frame marked final is rejected as truncated. Returns the recovered plaintext byte count and digests.
 */
export async function streamDecrypt(s: StreamingApi, params: StreamDecryptParams): Promise<{ plaintextBytes: number; digests: PlaintextDigests }> {
	const { header, cipherKey, macKey, nodeHash, remainder } = params;
	const { algorithm, bitStrength, dk_id_hex, preamble, encoding } = header;

	const deframer = new CipherTextDeframer({ algorithm, bitStrength, cipherKey, macKey, nodeHash, dk_id_hex }, preamble);

	const digester = new PlaintextDigester();
	let plaintextBytes = 0;

	const release = async (plain: Buffer): Promise<void> => {
		if (plain.byteLength === 0) return;
		plaintextBytes += plain.byteLength;
		digester.update(plain);
		await s.write(plain);
	};

	// Whatever of the current frame segment has arrived so far; a frame is complete the moment its closing `.` (or the end of the body) is seen
	let partial = '';

	for await (const piece of remainder) {
		let rest = partial + piece;

		for (let cut = rest.indexOf('.'); cut !== -1; cut = rest.indexOf('.')) {
			await release(deframer.push(decodeFrame(rest.slice(0, cut), encoding)));
			rest = rest.slice(cut + 1);
		}

		if (rest.length > MAX_FRAME_CHARS) throw new Error('Invalid ciphertext framing - frame segment exceeds the maximum width');
		partial = rest;
	}

	// The body ends on the last frame rather than on a separator, so the tail is a frame too
	await release(deframer.push(decodeFrame(partial, encoding)));
	await release(deframer.finish());

	return { plaintextBytes, digests: digester.digest() };
}

function decodeFrame(segment: string, encoding: CipherTextEncoding): Uint8Array {
	if (segment.length === 0) throw new Error('Invalid ciphertext framing - empty frame segment');
	return new Uint8Array(Buffer.from(segment, encoding));
}
