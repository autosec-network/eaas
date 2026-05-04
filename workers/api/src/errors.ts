import { z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

const DOCS_BASE_URL = 'https://api.eaas.autosec.network/';

/** HTTP status code → short title per RFC 9110 */
const STATUS_TITLES: Readonly<Record<number, string>> = {
	400: 'Bad Request',
	401: 'Unauthorized',
	403: 'Forbidden',
	404: 'Not Found',
	405: 'Method Not Allowed',
	409: 'Conflict',
	422: 'Unprocessable Content',
	429: 'Too Many Requests',
	500: 'Internal Server Error',
	502: 'Bad Gateway',
	503: 'Service Unavailable',
};

/** First path segment after version → Scalar docs tag slug */
const PATH_TAG_MAP: Readonly<Record<string, string>> = {
	apikeys: 'api-key-management',
	noise: 'noise-pipe',
	random: 'free',
	stats: 'stats',
	hash: 'free',
	keyrings: 'keyring-management',
};

// ─── Serialised error shapes ─────────────────────────────────────────────────

interface ProblemErrorObject {
	name: string;
	message: string;
	cause?: string;
}

interface ProblemAggregateErrorObject {
	message: string;
	cause?: string;
	errors: (ProblemErrorObject | ProblemAggregateErrorObject)[];
}

type ProblemErrorEntry = ProblemErrorObject | ProblemAggregateErrorObject;

interface ProblemDetails {
	type: string;
	status: number;
	title: string;
	detail?: string;
	instance?: string;
	errors?: ProblemErrorEntry[];
}

// ─── Zod detection ───────────────────────────────────────────────────────────

interface ZodLikeError {
	name: string;
	issues: readonly { message: string; path?: PropertyKey[] }[];
}

/** Detect both zod v4 classic and zod/mini errors by structural shape */
function isZodError(error: unknown): error is ZodLikeError {
	return error != null && typeof error === 'object' && 'issues' in error && Array.isArray((error as ZodLikeError).issues);
}

// ─── Error serialisation ─────────────────────────────────────────────────────

function serializeZodError(error: ZodLikeError): ProblemErrorEntry {
	if (error.issues.length === 1) {
		return {
			name: error.name || '$ZodError',
			message: z.prettifyError(error),
		};
	}

	// Multiple issues from the same schema → AggregateError style
	return {
		message: z.prettifyError(error),
		errors: error.issues.map((issue) => ({
			name: error.name || '$ZodError',
			message: z.prettifyError({ issues: [issue] }),
		})),
	};
}

/** Recursively convert an Error (or unknown) to the problem error entry format */
export function serializeError(error: unknown): ProblemErrorEntry {
	if (error instanceof AggregateError) {
		return {
			message: error.message,
			...(error.cause != null && { cause: JSON.stringify(error.cause) }),
			errors: error.errors.map(serializeError),
		};
	}

	if (isZodError(error)) {
		return serializeZodError(error);
	}

	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			...(error.cause != null && { cause: JSON.stringify(error.cause) }),
		};
	}

	return { name: 'Error', message: JSON.stringify(error) };
}

// ─── Type URI builder ────────────────────────────────────────────────────────

/**
 * Build an RFC 9457 `type` URI that deep-links into the Scalar API docs.
 *
 * Format: `https://api.eaas.autosec.network/#tag/{tag-slug}/{METHOD}/{path}`
 *
 * Falls back to `about:blank` when the tag cannot be derived.
 */
function buildTypeUri(c: Context, method?: string): string {
	const path = c.req.path;
	const parts = path.split('/').filter(Boolean);

	// Find the version segment (e.g. "v0")
	const versionIdx = parts.findIndex((p) => /^v\d+$/i.test(p));
	const afterVersion = versionIdx >= 0 ? parts.slice(versionIdx + 1) : parts;

	const firstSegment = afterVersion[0]?.toLowerCase();
	const tagSlug = firstSegment ? PATH_TAG_MAP[firstSegment] : undefined;

	const httpMethod = (method ?? c.req.method).toUpperCase();

	// Convert Hono-style `:param` to OpenAPI-style `{param}` for the fragment
	const routePath = afterVersion.map((seg) => (seg.startsWith(':') ? `{${seg.slice(1)}}` : seg)).join('/');

	if (tagSlug && routePath) {
		return `${DOCS_BASE_URL}#tag/${tagSlug}/${httpMethod}/${routePath}`;
	}

	return 'about:blank';
}

// ─── Public helpers ──────────────────────────────────────────────────────────

export interface ProblemJsonOptions {
	/** Human-readable explanation specific to this occurrence */
	detail?: string;
	/** Override the title (defaults to the standard phrase for the status code) */
	title?: string;
	/** Override the type URI (defaults to Scalar docs deep link) */
	type?: string;
	/** Error(s) to include in the `errors` extension property */
	errors?: unknown[];
}

/**
 * Return an RFC 9457 `application/problem+json` response.
 *
 * ```ts
 * return problemJson(c, 403, { detail: 'Access denied' });
 * ```
 */
export function problemJson(c: Context, status: ContentfulStatusCode, options: ProblemJsonOptions = {}) {
	const body: ProblemDetails = {
		type: options.type ?? buildTypeUri(c),
		status,
		title: options.title ?? STATUS_TITLES[status] ?? 'Error',
		...(options.detail && { detail: options.detail }),
		instance: c.req.path,
	};

	if (options.errors?.length) {
		body.errors = options.errors.map(serializeError);
	}

	return c.json(body, status, { 'Content-Type': 'application/problem+json' });
}

/**
 * Build an RFC 9457 problem JSON body from a Zod validation failure
 * (used in defaultHook and zValidator hooks).
 */
export function problemJsonValidation(c: Context, zodError: unknown, status: ContentfulStatusCode = 400, detail: string = 'Request validation failed') {
	const errors = isZodError(zodError) ? [serializeZodError(zodError)] : [serializeError(zodError)];

	const body: ProblemDetails = {
		type: buildTypeUri(c),
		status,
		title: STATUS_TITLES[status] ?? 'Error',
		detail,
		instance: c.req.path,
		errors,
	};

	return c.json(body, status, { 'Content-Type': 'application/problem+json' });
}

// ─── OpenAPI response schemas ────────────────────────────────────────────────

/**
 * Reusable RFC 9457 Problem Details schema for OpenAPI response definitions.
 * The `errors` array is typed loosely (`z.any()`) to avoid recursive `z.lazy()` which crashes the OpenAPI 3.1 generator at doc-generation time.
 * */
export const problemDetailsSchema = z.object({
	type: z.url().openapi({ example: 'https://api.eaas.autosec.network/#tag/api-key-management/DELETE/apikeys/{token_id}' }),
	status: z.int().min(100).max(599).openapi({ example: 400 }),
	title: z.string().openapi({ example: 'Bad Request' }),
	detail: z.string().optional().openapi({ example: 'Request validation failed' }),
	instance: z.string().optional().openapi({ example: '/v0/apikeys' }),
	errors: z.array(z.any()).optional(),
});

/**
 * Shorthand for an OpenAPI error response definition using RFC 9457.
 *
 * ```ts
 * responses: {
 *   403: problemResponse('Access denied.'),
 * }
 * ```
 */
export function problemResponse(description: string) {
	return {
		content: {
			'application/problem+json': {
				schema: problemDetailsSchema,
			},
		},
		description,
	};
}
