import { zValidator } from '@hono/zod-validator';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { CipherBitStrengths, detectCipherTextEncoding, parseCipherText0, type CipherBitStrength } from 'helpers/ciphertext';
import { bodyLimit } from 'hono/body-limit';
import { stream } from 'hono/streaming';
import { Buffer } from 'node:buffer';
import { AnalyticsSize } from 'types';
import { EncryptionAlgorithms } from 'types/crypto';
import { TenantLogEventStatus, TenantLogEventType } from 'types/tenants/logging';
import { problemJson, problemResponse } from '~/errors';
import type { ContextVariables, EnvVars } from '~/types';
import { analyticsSizeBucket, assertPreambleLength, decryptBuffered, deriveKeys, digestPlaintext, emitAnalytics, emitOperationLog, fetchDatakeys, fetchTenantProperties, loadDatakeyMaterial, nodeCipherName, normalizeHash, recordDatakeyUsage, resolveBitStrength, resolveKeyring, uploadFilename, type PlaintextDigests } from '~/v0/crypto/shared';
import { streamDecrypt, type StreamDecryptParsedHeader } from '~/v0/crypto/stream';
import { APITags } from '~/v0/extras';

const app = new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>();

const JSON_BODY_LIMIT = 25 * 1024 * 1024;

const outputFormats = ['utf8', 'hex', 'base64', 'base64url'] as const;

// At least one keyring must grant decrypt; the per-keyring check happens in the handlers.
// @ts-expect-error Hono middleware doesn't need to return when calling await next()
app.use('*', async (c, next) => {
	if (Object.values(c.var.permissions).some(({ r_decrypt }) => r_decrypt)) {
		await next();
	} else {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
		return problemJson(c, 403, { detail: 'Access Denied: You do not have permission to perform this action' });
	}
});

const embeddedItem = z.object({
	keyringName: z.string().trim().min(1).toLowerCase().describe('The keyring the ciphertext was encrypted with, case-insensitive'),
	input: z.string().trim().min(1).describe('The ciphertext, as produced by the encrypt endpoint').openapi({ example: '0.MDAw….cHJlYW1ibGU.ZnJhbWUw.ZnJhbWUx' }),
	outputFormat: z.enum(outputFormats).describe('The encoding of the returned plaintext').openapi({ example: 'utf8' }),
	reference: z.string().trim().optional().describe('An opaque caller-supplied string, echoed back on the result, to correlate a response with the request that produced it'),
});

/**
 * One ciphertext per request, matching the encrypt side and the upload route below, so every path through this API is one payload in and one payload out. Concurrency is the caller's to choose, and Workers scale across requests better than one isolate loops over a batch.
 */
export const embeddedRoute = createRoute({
	tags: [APITags.Decrypt],
	method: 'post',
	path: '/',
	description: 'Decrypt one ciphertext produced by the encrypt endpoint.',
	request: {
		body: {
			content: {
				'application/json': {
					schema: embeddedItem.openapi('DecryptInput'),
				},
			},
		},
	},
	responses: {
		200: {
			content: {
				'application/json': {
					schema: z
						.object({
							success: z.boolean(),
							result: z.object({
								value: z.string().trim().describe('The recovered plaintext, encoded per the request `outputFormat`').openapi({ example: 'Hello world' }),
								reference: z.string().trim().optional().describe('The `reference` from the request, if one was sent'),
							}),
						})
						.openapi('DecryptOutput'),
				},
			},
			description: 'The plaintext',
		},
		400: problemResponse('Malformed ciphertext.'),
		403: problemResponse('Access denied.'),
		422: problemResponse('A ciphertext failed verification.'),
		500: problemResponse('Internal server error.'),
	},
});

/**
 * One payload's entry in the audit row's `context`. The digest is of the recovered plaintext, so a tenant can tie the logged operation back to the content it produced - see `PLAINTEXT_DIGEST_ALGORITHMS`.
 */
interface OperationRecord {
	algorithm: EncryptionAlgorithms;
	/** `null` for an algorithm with no choice of key size, such as ChaCha20-Poly1305 - recorded explicitly rather than omitted, so every row has the same shape. */
	bitStrength: CipherBitStrength | null;
	cipher: string;
	size: keyof typeof AnalyticsSize;
	digest: PlaintextDigests;
}

app.use('/', bodyLimit({ maxSize: JSON_BODY_LIMIT, onError: (c) => problemJson(c, 413, { detail: `Request body exceeds the ${JSON_BODY_LIMIT} byte JSON limit; use the file upload endpoint for larger data` }) }));

app.openapi(embeddedRoute, async (c) => {
	const item = c.req.valid('json');

	// Parse the ciphertext first, so a malformed one fails before any key is touched
	let cipherParts: Awaited<ReturnType<typeof parseCipherText0>>;
	try {
		cipherParts = await parseCipherText0(item.input);
	} catch (error) {
		return problemJson(c, 400, { detail: 'Malformed ciphertext', errors: [error] });
	}

	const keyring = resolveKeyring(c, item.keyringName, 'r_decrypt');
	if (!keyring) {
		emitOperationLog(c, { event_type: TenantLogEventType['decrypted data'], context: { denied: [item.keyringName] }, status: TenantLogEventStatus.denied });
		return problemJson(c, 403, { detail: `Access Denied: no decrypt permission on keyring "${item.keyringName}"` });
	}

	// Rejects a ciphertext whose header disagrees with its own algorithm - a strength attached to ChaCha20-Poly1305, or one missing from an AES mode - before any key is derived from it
	let bitStrength: CipherBitStrength | undefined;
	try {
		bitStrength = resolveBitStrength(cipherParts.algorithm, cipherParts.bitStrength);
	} catch (error) {
		return problemJson(c, 400, { detail: error instanceof Error ? error.message : 'Malformed ciphertext', errors: [error] });
	}

	const tenantProperties = await fetchTenantProperties(c);

	// Only the newest `retreival_versions + 1` data keys may still be decrypted with
	const datakeyRow = (await fetchDatakeys(c, keyring.kr_id_hex, keyring.retreival_versions + 1)).find((dk) => dk.dk_id_hex === cipherParts.dk_id_hex);
	if (!datakeyRow) {
		emitOperationLog(c, { event_type: TenantLogEventType['decrypted data'], kr_id_hex: keyring.kr_id_hex, dk_id_hex: cipherParts.dk_id_hex, context: { outOfRetrievalWindow: true }, status: TenantLogEventStatus.denied });
		return problemJson(c, 403, { detail: "Ciphertext references a data key outside the keyring's retrieval window" });
	}

	const [material] = await loadDatakeyMaterial(c, [datakeyRow], tenantProperties.byo_bw);
	if (!material) return problemJson(c, 500, { detail: `Could not load key material for keyring "${item.keyringName}"` });

	const { cipherKey, macKey } = await deriveKeys(material, cipherParts.algorithm, bitStrength);

	let plaintext: Buffer;
	try {
		plaintext = decryptBuffered({ algorithm: cipherParts.algorithm, bitStrength, cipherKey, macKey, nodeHash: normalizeHash(material.hash), dk_id_hex: cipherParts.dk_id_hex, preamble: cipherParts.preamble, frames: cipherParts.frames });
	} catch (error) {
		emitOperationLog(c, { event_type: TenantLogEventType['decrypted data'], kr_id_hex: keyring.kr_id_hex, dk_id_hex: cipherParts.dk_id_hex, context: { reason: 'verification failed' }, status: TenantLogEventStatus.error });
		return problemJson(c, 422, { detail: `Decryption failed${item.reference ? ` for "${item.reference}"` : ''} - the ciphertext could not be verified`, errors: [error] });
	}

	const cipher = nodeCipherName(cipherParts.algorithm, bitStrength);

	// `operations` stays an array of one so this row is the same shape as the upload route's and as encrypt's, which the analytics preview reads positionally
	emitOperationLog(c, {
		event_type: TenantLogEventType['decrypted data'],
		kr_id_hex: keyring.kr_id_hex,
		dk_id_hex: cipherParts.dk_id_hex,
		context: {
			count: 1,
			size: AnalyticsSize[analyticsSizeBucket(plaintext.byteLength)],
			operations: [{ algorithm: cipherParts.algorithm, bitStrength: bitStrength ?? null, cipher, size: AnalyticsSize[analyticsSizeBucket(plaintext.byteLength)] as keyof typeof AnalyticsSize, digest: digestPlaintext(plaintext) }] satisfies OperationRecord[],
		},
		status: TenantLogEventStatus.success,
	});
	emitAnalytics(c, 'decrypt', [{ cipher, byteLength: plaintext.byteLength }], tenantProperties.platform_analytics ?? true);
	// A decrypt reads with the key rather than generating under it, so only `a_time` moves
	recordDatakeyUsage(c, cipherParts.dk_id_hex, 0);

	return c.json({ success: true, result: { value: plaintext.toString(item.outputFormat), ...(item.reference !== undefined && { reference: item.reference }) } }, 200);
});

// ─── Streaming file upload ───────────────────────────────────────────────────
app.openAPIRegistry.registerPath({
	tags: [APITags.Decrypt],
	method: 'post',
	path: '/{keyringName}',
	description: 'Decrypt a ciphertext file sent as the raw request body, streaming the plaintext back as a download. The body is read and written a chunk at a time and is never held whole, so there is no size limit. The algorithm and strength are read from the ciphertext itself. The download is named from `X-Filename`, or from the `Content-Disposition` request header, with a trailing `.enc` removed.',
	request: {
		params: z.object({ keyringName: z.string().openapi({ example: 'my-keyring' }) }),
		body: { content: { 'application/octet-stream': { schema: z.string().openapi({ format: 'binary', description: 'The ciphertext file as the raw request body' }) } } },
	},
	responses: {
		200: { content: { 'application/octet-stream': { schema: z.string().openapi({ format: 'binary' }) } }, description: 'The streamed plaintext download' },
		400: problemResponse('Bad request.'),
		403: problemResponse('Access denied.'),
		422: problemResponse('The ciphertext failed verification.'),
		500: problemResponse('Internal server error.'),
	},
});

app.post('/:keyringName', zValidator('param', z.object({ keyringName: z.string().trim().min(1).toLowerCase() })), async (c) => {
	const { keyringName } = c.req.valid('param');

	const keyring = resolveKeyring(c, keyringName, 'r_decrypt');
	if (!keyring) {
		emitOperationLog(c, { event_type: TenantLogEventType['decrypted data'], context: { denied: [keyringName] }, status: TenantLogEventStatus.denied });
		return problemJson(c, 403, { detail: `Access Denied: no decrypt permission on keyring "${keyringName}"` });
	}

	// Held in a local because the narrowing has to survive into the streaming callback below
	const body = c.req.raw.body;
	if (!body) return problemJson(c, 400, { detail: 'Expected the ciphertext file as the raw request body' });

	// Read only the small leading header; `split.remainder` stays a lazy view of the same body stream
	let split: Awaited<ReturnType<typeof splitCipherHeader>>;
	try {
		split = await splitCipherHeader(body);
	} catch (error) {
		return problemJson(c, 400, { detail: 'Could not read the ciphertext stream', errors: [error] });
	}
	if (!split) return problemJson(c, 400, { detail: 'Malformed ciphertext file - could not read its header' });

	let header: StreamDecryptParsedHeader;
	let bitStrength: CipherBitStrength | undefined;
	try {
		header = parseStreamHeader(split.headerText);
		// Rejects a header claiming a strength its own algorithm cannot have before any key is derived from it
		bitStrength = resolveBitStrength(header.algorithm, header.bitStrength);
	} catch (error) {
		return problemJson(c, 400, { detail: error instanceof Error ? error.message : 'Malformed ciphertext header', errors: [error] });
	}

	const tenantProperties = await fetchTenantProperties(c);
	const window = await fetchDatakeys(c, keyring.kr_id_hex, keyring.retreival_versions + 1);
	const datakeyRow = window.find((dk) => dk.dk_id_hex === header.dk_id_hex);
	if (!datakeyRow) {
		emitOperationLog(c, { event_type: TenantLogEventType['decrypted data'], kr_id_hex: keyring.kr_id_hex, dk_id_hex: header.dk_id_hex, context: { outOfRetrievalWindow: true }, status: TenantLogEventStatus.denied });
		return problemJson(c, 403, { detail: "Ciphertext references a data key outside the keyring's retrieval window" });
	}

	const [material] = await loadDatakeyMaterial(c, [datakeyRow], tenantProperties.byo_bw);
	if (!material) return problemJson(c, 500, { detail: `Could not load key material for keyring "${keyringName}"` });

	const nodeHash = normalizeHash(material.hash);
	const { cipherKey, macKey } = await deriveKeys(material, header.algorithm, bitStrength);
	const cipher = nodeCipherName(header.algorithm, bitStrength);
	// Drop the `.enc` the encrypt route appended, so a round trip returns the name the file started with
	const outName = uploadFilename(c, 'file').replace(/\.enc$/i, '') || 'decrypted';

	c.header('Content-Type', 'application/octet-stream');
	c.header('Content-Disposition', `attachment; filename="${outName}"`);

	return stream(
		c,
		async (s) => {
			const { plaintextBytes, digests } = await streamDecrypt(s, { header, cipherKey, macKey, nodeHash, remainder: split.remainder });

			emitOperationLog(c, {
				event_type: TenantLogEventType['decrypted data'],
				kr_id_hex: keyring.kr_id_hex,
				dk_id_hex: header.dk_id_hex,
				context: {
					count: 1,
					size: AnalyticsSize[analyticsSizeBucket(plaintextBytes)],
					filename: outName,
					operations: [{ algorithm: header.algorithm, bitStrength: bitStrength ?? null, cipher, size: AnalyticsSize[analyticsSizeBucket(plaintextBytes)] as keyof typeof AnalyticsSize, digest: digests }] satisfies OperationRecord[],
				},
				status: TenantLogEventStatus.success,
			});
			emitAnalytics(c, 'decrypt', [{ cipher, byteLength: plaintextBytes }], tenantProperties.platform_analytics ?? true);
			recordDatakeyUsage(c, header.dk_id_hex, 0);
		},
		// A verification failure surfaces only after plaintext has begun streaming: abort the download rather than complete it, and record the failure
		(error, s) => {
			emitOperationLog(c, { event_type: TenantLogEventType['decrypted data'], kr_id_hex: keyring.kr_id_hex, dk_id_hex: header.dk_id_hex, context: { reason: 'verification failed' }, status: TenantLogEventStatus.error });
			recordDatakeyUsage(c, header.dk_id_hex, 0);
			console.error('Streaming decryption failed', error);
			s.abort();
			return Promise.resolve();
		},
	);
});

/**
 * The most characters the five leading header segments may occupy before the stream is rejected as malformed.
 *
 * A real header is about 110 characters at its longest (hex, the widest encoding, over a 17-character algorithm name and a 16-byte preamble). Without a ceiling a body that simply never sends a fifth `.` would be accumulated into `headerText` forever, which matters now that the route itself imposes no size limit.
 */
const MAX_HEADER_CHARS = 1024;

/**
 * Split a ciphertext stream's small leading header (`version.dk_id.algorithm.bitStrength.preamble`, the first five dot-separated segments) from the frames that follow.
 *
 * Only the header is read eagerly. The rest is handed back as a lazy async iterable over the same reader, so the frames are never accumulated and a multi-gigabyte upload costs one frame of memory at a time. Returns `null` when the stream ends, or {@link MAX_HEADER_CHARS} is passed, before five separators are seen.
 *
 * `latin1` is the decoding throughout because every character a `cipherText0` can contain is ASCII, and latin1 is the one single-byte decoding that never merges or replaces a byte, so a chunk boundary can fall anywhere - including mid-segment - without corrupting the text.
 */
export async function splitCipherHeader(chunks: AsyncIterable<Uint8Array>): Promise<{ headerText: string; remainder: AsyncIterable<string> } | null> {
	const iterator = chunks[Symbol.asyncIterator]();
	let headerText = '';
	let dots = 0;

	for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
		const text = Buffer.from(next.value).toString('latin1');

		let cut = -1;
		for (let i = 0; i < text.length; i++) {
			if (text[i] !== '.') continue;
			dots++;
			if (dots === 5) {
				cut = i;
				break;
			}
		}

		if (cut === -1) {
			headerText += text;
			// A header this long is not a header; stop reading rather than grow without bound
			if (headerText.length > MAX_HEADER_CHARS) return null;
			continue;
		}

		headerText += text.slice(0, cut);
		// Whatever followed the fifth `.` in this same chunk is already the first frame, so it has to lead the remainder
		return { headerText, remainder: drainRemainder(iterator, text.slice(cut + 1)) };
	}

	return null;
}

/**
 * The frames, continuing the very iterator {@link splitCipherHeader} left off on: the tail of the chunk the header ended in, then every later chunk as it arrives.
 */
async function* drainRemainder(iterator: AsyncIterator<Uint8Array>, first: string): AsyncGenerator<string> {
	if (first.length > 0) yield first;
	for (let next = await iterator.next(); !next.done; next = await iterator.next()) yield Buffer.from(next.value).toString('latin1');
}

/**
 * Turn a ciphertext's five leading header segments into the {@link StreamDecryptParsedHeader} the streaming decryptor needs, detecting the encoding from the data key segment exactly as {@link parseCipherText0} does for the buffered path.
 */
export function parseStreamHeader(headerText: string): StreamDecryptParsedHeader {
	// The strength segment is legitimately empty for an algorithm with no choice of key size, so it is the only one not required to carry anything
	const [version, dkSegment, algorithmSegment, bitStrengthSegment, preambleSegment] = headerText.split('.');
	if (version !== '0' || !dkSegment || !algorithmSegment || bitStrengthSegment === undefined || preambleSegment === undefined) throw new Error('Ciphertext header is incomplete');

	const encoding = detectCipherTextEncoding(dkSegment);
	if (!encoding) throw new Error('Ciphertext header uses an unrecognized encoding');

	const algorithm = Buffer.from(algorithmSegment, encoding).toString('utf8');
	if (!(Object.values(EncryptionAlgorithms) as string[]).includes(algorithm)) throw new Error(`Unsupported algorithm "${algorithm}"`);

	const bitStrength = bitStrengthSegment.length > 0 ? Buffer.from(bitStrengthSegment, encoding).toString('utf8') : undefined;
	if (bitStrength !== undefined && !(CipherBitStrengths as readonly string[]).includes(bitStrength)) throw new Error(`Unsupported bitStrength "${bitStrength}"`);

	const preamble = new Uint8Array(Buffer.from(preambleSegment, encoding));
	assertPreambleLength(algorithm as EncryptionAlgorithms, preamble);

	return { encoding, dk_id_hex: Buffer.from(dkSegment, encoding).toString('hex'), algorithm: algorithm as EncryptionAlgorithms, bitStrength: bitStrength as CipherBitStrength | undefined, preamble };
}

export default app;
