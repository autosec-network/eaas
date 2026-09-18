import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { zValidator } from '@hono/zod-validator';
import { cipherText0, CipherBitStrengths, CipherTextEncodings, type CipherBitStrength } from 'helpers/ciphertext';
import { bodyLimit } from 'hono/body-limit';
import { stream } from 'hono/streaming';
import { Buffer } from 'node:buffer';
import { AnalyticsSize } from 'types';
import { EncryptionAlgorithms } from 'types/crypto';
import { TenantLogEventStatus, TenantLogEventType } from 'types/tenants/logging';
import { problemJson, problemResponse } from '~/errors';
import type { ContextVariables, EnvVars } from '~/types';
import { analyticsSizeBucket, deriveKeys, digestPlaintext, emitAnalytics, emitOperationLog, encryptBuffered, fetchDatakeys, fetchTenantProperties, loadDatakeyMaterial, nodeCipherName, normalizeHash, recordDatakeyUsage, resolveBitStrength, resolveKeyring, uploadFilename, type PlaintextDigests } from '~/v0/crypto/shared';
import { streamEncrypt } from '~/v0/crypto/stream';
import { APITags } from '~/v0/extras';

const app = new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>();

// Cap the JSON path only - it buffers the whole body in memory (and base64 in JSON is ~1.33x the plaintext). Large payloads belong on the streaming upload route, which carries no such limit.
const JSON_BODY_LIMIT = 25 * 1024 * 1024;

// At least one keyring must grant encrypt; the per-keyring check happens in the handlers, where the keyring name is known.
// @ts-expect-error Hono middleware doesn't need to return when calling await next()
app.use('*', async (c, next) => {
	if (Object.values(c.var.permissions).some(({ r_encrypt }) => r_encrypt)) {
		await next();
	} else {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
		return problemJson(c, 403, { detail: 'Access Denied: You do not have permission to perform this action' });
	}
});

const inputFormats = ['utf8', 'hex', 'base64', 'base64url'] as const;
type InputFormat = (typeof inputFormats)[number];

/**
 * What `input` must actually look like for each `inputFormat`, checked because `Buffer.from` does not check: it answers an empty buffer for `'zz'` as hex and truncates `'abc'` to a single byte rather than throwing, so a malformed payload would otherwise encrypt to a ciphertext of the wrong content with no error anywhere. `utf8` has no invalid form - every JSON string is valid UTF-8 - so it is the one format with nothing to assert.
 */
const inputFormatSchemas: Record<InputFormat, z.ZodType<string>> = {
	utf8: z.string(),
	hex: z.hex().refine((value) => value.length % 2 === 0, 'Hex input must have an even number of characters'),
	base64: z.base64(),
	base64url: z.base64url(),
};

/**
 * Everything an encrypt request carries regardless of algorithm. The algorithm-specific half - whether a `bitStrength` is accepted at all - is layered on by the discriminated union below.
 */
const embeddedBase = z.object({
	keyringName: z.string().trim().min(1).toLowerCase().describe('The keyring to encrypt with, case-insensitive'),
	outputFormat: z.enum(CipherTextEncodings).describe('The encoding of the returned ciphertext').openapi({ example: 'base64' }),
	input: z
		.string()
		.trim()
		.describe('The data to encrypt, in `inputFormat`')
		.openapi({ example: Buffer.from('Hello world', 'utf8').toString('utf8') }),
	inputFormat: z.enum(inputFormats).describe('The encoding of `input`').openapi({ example: 'utf8' }),
	reference: z.string().trim().optional().describe('An opaque caller-supplied string, echoed back on the result, to correlate a response with the request that produced it'),
});

/**
 * The AES modes, whose key size the caller chooses.
 */
const sizedAlgorithms = [EncryptionAlgorithms['AES-CBC'], EncryptionAlgorithms['AES-CTR'], EncryptionAlgorithms['AES-GCM']] as const;

/**
 * Discriminated on `algorithm` so Zod rejects the combinations that make no sense rather than leaving them to a runtime check: the AES modes require a `bitStrength`, while ChaCha20-Poly1305 is defined only for a 256-bit key and therefore takes none at all.
 */
const embeddedItem = z
	.discriminatedUnion('algorithm', [
		embeddedBase.extend({
			algorithm: z.enum(sizedAlgorithms).describe('An AES mode, whose key strength you choose').openapi({ example: EncryptionAlgorithms['AES-GCM'] }),
			bitStrength: z.enum(CipherBitStrengths).describe('The cipher key strength in bits').openapi({ example: '256' }),
		}),
		// `.strict()` so a `bitStrength` sent alongside ChaCha20-Poly1305 is rejected ("Unrecognized key") rather than silently stripped - dropping it would leave the caller believing they got a key size this algorithm cannot produce. A `z.undefined()` field would say the same thing but cannot be rendered into OpenAPI.
		embeddedBase
			.extend({
				algorithm: z.literal(EncryptionAlgorithms['ChaCha20-Poly1305']).describe('ChaCha20-Poly1305, which has no configurable key strength').openapi({ example: EncryptionAlgorithms['ChaCha20-Poly1305'] }),
			})
			.strict(),
	])
	// Cross-field, so it hangs off the union rather than a field: the rule depends on a sibling, and attaching it to `embeddedBase` would stop the branches being built with `.extend()`
	.superRefine((value, ctx) => {
		if (!inputFormatSchemas[value.inputFormat].safeParse(value.input).success) ctx.addIssue({ code: 'custom', path: ['input'], message: `Input is not valid ${value.inputFormat}` });
	});

/**
 * One payload per request, deliberately - the same shape as the upload route below, so the two differ only in how the payload arrives and not in what a caller has to construct. Callers wanting throughput send concurrent requests, which Workers scale across far better than one request doing N encryptions on a single isolate's CPU and memory budget.
 */
export const embeddedRoute = createRoute({
	tags: [APITags.Encrypt],
	method: 'post',
	path: '/',
	description: 'Encrypt one payload against a keyring. Returns a self-describing ciphertext string.',
	request: {
		body: {
			content: {
				'application/json': {
					schema: embeddedItem.openapi('EncryptInput'),
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
								value: z.string().trim().describe('The ciphertext, encoded per the request `outputFormat`: `0.<dk_id>.<algorithm>.<bitStrength>.<preamble>` followed by one or more independently signed frames').openapi({ example: '0.MDAw….cHJlYW1ibGU.ZnJhbWUw.ZnJhbWUx' }),
								reference: z.string().trim().optional().describe('The `reference` from the request, if one was sent'),
							}),
						})
						.openapi('EncryptOutput'),
				},
			},
			description: 'The ciphertext',
		},
		403: problemResponse('Access denied.'),
		422: problemResponse('No input could be encrypted.'),
		500: problemResponse('Internal server error.'),
	},
});

/**
 * One payload's entry in the audit row's `context`. The digest is of the plaintext, so a tenant can tie the logged operation back to the content it ran on - see `PLAINTEXT_DIGEST_ALGORITHMS`.
 */
interface OperationRecord {
	algorithm: EncryptionAlgorithms;
	/** `null` for an algorithm with no choice of key size, such as ChaCha20-Poly1305 - recorded explicitly rather than omitted, so every row has the same shape. */
	bitStrength: CipherBitStrength | null;
	cipher: string;
	size: keyof typeof AnalyticsSize;
	digest: PlaintextDigests;
}

app.use(
	'/',
	bodyLimit({
		maxSize: JSON_BODY_LIMIT,
		onError: (c) => problemJson(c, 413, { detail: `Request body exceeds the ${JSON_BODY_LIMIT} byte JSON limit; use the file upload endpoint for larger data` }),
	}),
);

app.openapi(embeddedRoute, async (c) => {
	const item = c.req.valid('json');

	const keyring = resolveKeyring(c, item.keyringName, 'r_encrypt');
	if (!keyring) {
		emitOperationLog(c, { event_type: TenantLogEventType['encrypted data'], context: { denied: [item.keyringName] }, status: TenantLogEventStatus.denied });
		return problemJson(c, 403, { detail: `Access Denied: no encrypt permission on keyring "${item.keyringName}"` });
	}

	const tenantProperties = await fetchTenantProperties(c);

	const [newest] = await fetchDatakeys(c, keyring.kr_id_hex, keyring.generation_versions + 1);
	if (!newest) return problemJson(c, 500, { detail: `Keyring "${item.keyringName}" has no data key to encrypt with` });

	const [material] = await loadDatakeyMaterial(c, [newest], tenantProperties.byo_bw);
	if (!material) return problemJson(c, 500, { detail: `Could not load key material for keyring "${item.keyringName}"` });

	// ChaCha20-Poly1305 carries no `bitStrength` on the request; its fixed 256 is filled in here and still travels in the ciphertext
	const bitStrength = resolveBitStrength(item.algorithm, 'bitStrength' in item ? item.bitStrength : undefined);
	const nodeHash = normalizeHash(material.hash);
	const { cipherKey, macKey } = await deriveKeys(material, item.algorithm, bitStrength);
	const input = new Uint8Array(Buffer.from(item.input, item.inputFormat));

	const parts = encryptBuffered({ algorithm: item.algorithm, bitStrength, cipherKey, macKey, nodeHash, dk_id_hex: material.dk_id_hex, input });
	const cipher = nodeCipherName(item.algorithm, bitStrength);

	// `operations` stays an array of one so this row is the same shape as the upload route's and as decrypt's, which the analytics preview reads positionally
	emitOperationLog(c, {
		event_type: TenantLogEventType['encrypted data'],
		kr_id_hex: keyring.kr_id_hex,
		dk_id_hex: material.dk_id_hex,
		context: {
			count: 1,
			size: AnalyticsSize[analyticsSizeBucket(input.byteLength)],
			operations: [{ algorithm: item.algorithm, bitStrength: bitStrength ?? null, cipher, size: AnalyticsSize[analyticsSizeBucket(input.byteLength)] as keyof typeof AnalyticsSize, digest: digestPlaintext(input) }] satisfies OperationRecord[],
		},
		status: TenantLogEventStatus.success,
	});
	emitAnalytics(c, 'encrypt', [{ cipher, byteLength: input.byteLength }], tenantProperties.platform_analytics ?? true);
	recordDatakeyUsage(c, material.dk_id_hex, 1);

	return c.json({ success: true, result: { value: cipherText0(item.outputFormat, parts), ...(item.reference !== undefined && { reference: item.reference }) } }, 200);
});

// ─── Streaming file upload ───────────────────────────────────────────────────
// Registered by hand (not via `app.openapi`) so the request body is consumed as a raw stream rather than buffered by the OpenAPI body validator.
//
// The file is the body, with no multipart wrapper: every multipart parser available here materializes a part before yielding it, which would put a whole gigabyte-scale upload in memory at once. Reading `c.req.raw.body` directly is what makes the route genuinely unbounded, and the metadata a form would have carried is already in the path, the query, and the filename headers.
const uploadBody = { content: { 'application/octet-stream': { schema: z.string().openapi({ format: 'binary', description: 'The file to encrypt as the raw request body' }) } } };
const uploadQuery = z.object({ format: z.enum(CipherTextEncodings).optional().openapi({ example: 'base64' }) });
const uploadResponses = {
	200: { content: { 'text/plain': { schema: z.string().openapi({ description: 'The streamed ciphertext string' }) } }, description: 'The ciphertext download' },
	400: problemResponse('Bad request.'),
	403: problemResponse('Access denied.'),
	500: problemResponse('Internal server error.'),
};

// Two documented shapes for one handler, mirroring the discriminated union above: the AES modes take a strength segment, ChaCha20-Poly1305 has none to take.
app.openAPIRegistry.registerPath({
	tags: [APITags.Encrypt],
	method: 'post',
	path: '/{keyringName}/{algorithm}/{bitStrength}',
	description: 'Encrypt a file sent as the raw request body with an AES mode, streaming the ciphertext back as a download. The body is read and written a chunk at a time and is never held whole, so there is no size limit. The download is named from `X-Filename`, or from the `Content-Disposition` request header, with `.enc` appended.',
	request: {
		params: z.object({
			keyringName: z.string().openapi({ example: 'my-keyring' }),
			algorithm: z.enum(sizedAlgorithms).openapi({ example: EncryptionAlgorithms['AES-GCM'] }),
			bitStrength: z.enum(CipherBitStrengths).openapi({ example: '256' }),
		}),
		query: uploadQuery,
		body: uploadBody,
	},
	responses: uploadResponses,
});
app.openAPIRegistry.registerPath({
	tags: [APITags.Encrypt],
	method: 'post',
	path: '/{keyringName}/{algorithm}',
	description: 'Encrypt a file sent as the raw request body with ChaCha20-Poly1305, streaming the ciphertext back as a download. The body is read and written a chunk at a time and is never held whole, so there is no size limit. The download is named from `X-Filename`, or from the `Content-Disposition` request header, with `.enc` appended.',
	request: {
		params: z.object({
			keyringName: z.string().openapi({ example: 'my-keyring' }),
			algorithm: z.literal(EncryptionAlgorithms['ChaCha20-Poly1305']).openapi({ example: EncryptionAlgorithms['ChaCha20-Poly1305'] }),
		}),
		query: uploadQuery,
		body: uploadBody,
	},
	responses: uploadResponses,
});

/**
 * Same split as the JSON body: the strength segment is required for the AES modes and must be absent for ChaCha20-Poly1305, so `/…/chacha20-poly1305/256` is rejected rather than quietly ignored.
 */
const uploadParams = z.discriminatedUnion('algorithm', [
	z.object({
		keyringName: z.string().trim().min(1).toLowerCase(),
		algorithm: z.enum(sizedAlgorithms),
		bitStrength: z.enum(CipherBitStrengths),
	}),
	z.object({
		keyringName: z.string().trim().min(1).toLowerCase(),
		algorithm: z.literal(EncryptionAlgorithms['ChaCha20-Poly1305']),
		bitStrength: z.undefined({ error: 'ChaCha20-Poly1305 has no configurable key strength; omit the bitStrength path segment' }).optional(),
	}),
]);

app.post('/:keyringName/:algorithm/:bitStrength?', zValidator('param', uploadParams), zValidator('query', z.object({ format: z.enum(CipherTextEncodings).optional() })), async (c) => {
	const param = c.req.valid('param');
	const encoding = c.req.valid('query').format ?? 'base64';
	const bitStrength = resolveBitStrength(param.algorithm, 'bitStrength' in param ? param.bitStrength : undefined);

	const keyring = resolveKeyring(c, param.keyringName, 'r_encrypt');
	if (!keyring) {
		emitOperationLog(c, { event_type: TenantLogEventType['encrypted data'], context: { denied: [param.keyringName] }, status: TenantLogEventStatus.denied });
		return problemJson(c, 403, { detail: `Access Denied: no encrypt permission on keyring "${param.keyringName}"` });
	}

	const tenantProperties = await fetchTenantProperties(c);
	const [newest] = await fetchDatakeys(c, keyring.kr_id_hex, keyring.generation_versions + 1);
	if (!newest) return problemJson(c, 500, { detail: `Keyring "${param.keyringName}" has no data key to encrypt with` });
	const [material] = await loadDatakeyMaterial(c, [newest], tenantProperties.byo_bw);
	if (!material) return problemJson(c, 500, { detail: `Could not load key material for keyring "${param.keyringName}"` });

	// Held in a local because the narrowing has to survive into the streaming callback below
	const body = c.req.raw.body;
	if (!body) return problemJson(c, 400, { detail: 'Expected the file to encrypt as the raw request body' });

	const { cipherKey, macKey } = await deriveKeys(material, param.algorithm, bitStrength);
	const nodeHash = normalizeHash(material.hash);
	const cipher = nodeCipherName(param.algorithm, bitStrength);
	// The download is the uploaded name with `.enc` appended, so a round trip through decrypt hands back the name the file started with
	const filename = uploadFilename(c, 'file');

	c.header('Content-Type', 'text/plain; charset=utf-8');
	c.header('Content-Disposition', `attachment; filename="${filename}.enc"`);

	return stream(
		c,
		async (s) => {
			// The request body streams straight into the cipher, so only one chunk is ever held
			const { plaintextBytes, digests } = await streamEncrypt(s, { algorithm: param.algorithm, bitStrength, encoding, cipherKey, macKey, nodeHash, dk_id_hex: material.dk_id_hex }, body);

			emitOperationLog(c, {
				event_type: TenantLogEventType['encrypted data'],
				kr_id_hex: keyring.kr_id_hex,
				dk_id_hex: material.dk_id_hex,
				context: {
					count: 1,
					size: AnalyticsSize[analyticsSizeBucket(plaintextBytes)],
					filename,
					operations: [{ algorithm: param.algorithm, bitStrength: bitStrength ?? null, cipher, size: AnalyticsSize[analyticsSizeBucket(plaintextBytes)] as keyof typeof AnalyticsSize, digest: digests }] satisfies OperationRecord[],
				},
				status: TenantLogEventStatus.success,
			});
			emitAnalytics(c, 'encrypt', [{ cipher, byteLength: plaintextBytes }], tenantProperties.platform_analytics ?? true);
			recordDatakeyUsage(c, material.dk_id_hex, 1);
		},
		// A failure here lands after the ciphertext has begun streaming, so the download is aborted rather than completed. The key was already used, so the count is still bumped, and the failure is recorded instead of the success row above.
		(error, s) => {
			emitOperationLog(c, { event_type: TenantLogEventType['encrypted data'], kr_id_hex: keyring.kr_id_hex, dk_id_hex: material.dk_id_hex, context: { reason: 'streaming encryption failed' }, status: TenantLogEventStatus.error });
			recordDatakeyUsage(c, material.dk_id_hex, 1);
			console.error('Streaming encryption failed', error);
			s.abort();
			return Promise.resolve();
		},
	);
});

export default app;
