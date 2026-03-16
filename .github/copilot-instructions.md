# GitHub Copilot Instructions for EaaS (Encryption as a Service)

## Project Overview

This is an **Encryption as a Service** platform inspired by HashiCorp Vault's Transit secrets engine, built with modern TypeScript and running entirely on Cloudflare Workers/Pages. The project provides cryptographic operations while integrating with Bitwarden Secrets Manager for key management.

## Technology Stack & Architecture

### Core Technologies

- **TypeScript** (Latest stable version with strict typing)
- **Cloudflare Workers/Pages** (Edge computing platform)
- **Qwik** (Frontend framework)
- **Hono** (Web framework for Workers)
- **Drizzle ORM** (Type-safe SQL toolkit with D1)
- **Bitwarden Secrets Manager** (External key management)
- **Post-Quantum Cryptography** (PQC container support)

### Project Structure

```
├── api/           # Hono-based API on Cloudflare Workers
│   └── pqc/       # Docker container for Node.js crypto with PQC algorithms
├── frontend/      # Qwik-based web interface
├── sidecar/       # Worker service (via service bindings) to bypass Qwik/Vite/Pages limitations
├── shared/        # Shared libraries and types
│   ├── db-core/   # Database management
│   ├── db-preview/# Database schemas (root/tenant)
│   ├── helpers/   # Utility classes (crypto, net, buffers)
│   └── types/     # Type definitions
├── devScripts/    # Development and CLI tools
└── wf/           # Cloudflare Workflows
```

## Coding Standards & Patterns

### Language & Framework Preferences

- **Always use the latest stable version** of TypeScript, libraries, and frameworks
- **Prioritize case insensitive** patterns where possible
- **Code in OOP form** with classes and methods grouped by logical actions
- **Prefer built-in libraries/frameworks** of the respective language
- **Avoid while loops** whenever possible (use for...of, map, filter, etc.)

### TypeScript Patterns

#### File Extensions

- **Prefer `.mts`** for TypeScript modules wherever possible (shared libraries, helpers, utilities)
- Use `.ts` only when required by platform constraints (Cloudflare Worker entry points, etc)
- Use `.tsx` for Qwik components and JSX files
- Use `.mjs` for JavaScript configuration files (ESLint, Prettier, Vite configs)

#### Class Structure

```typescript
export class HelperClass {
	// Static methods for utility functions
	public static methodName(): ReturnType {}

	// Instance methods for stateful operations
	public instanceMethod(): ReturnType {}

	// Private methods for internal logic
	private internalMethod(): ReturnType {}
}
```

#### Type Definitions

- Use comprehensive interface definitions with proper JSDoc
- Leverage TypeScript's strict type checking
- Use generic types extensively for reusability
- Prefer `type` for unions and `interface` for object shapes
- For Zod imports, always alias by version when importing directly from `zod/*`: `import * as zm from 'zod/mini'`, `import * as z4 from 'zod/v4'`, `import { z as z3 } from 'zod/v3'`. For `z` re-exported from a framework package (e.g. `zod$` from `@builder.io/qwik-city`, Hono's Zod validator, Hono Zod OpenAPI, etc.), import it as plain `z` — the upstream version is unknown and aliasing would be misleading
- Prefer `zod/mini` wherever possible; when using `zod$` in Qwik City, keep the primary schema in Zod 3 and embed stricter mini validation with `.refine(...)` or `.check(...)` plus `safeParse(...)` only when mini provides a more precise built-in validator
- Do not introduce regex validation when an equivalent Zod validator already exists, such as ISO datetime or base64url checks
- **Zod string validator availability by version** — know which validators exist in which version before using them:
    - `.hex()` — available in Zod 4 (`z4`) and Zod mini (`zm`) only; **not available in Zod 3**. Use `zm.hex()` inside a `.refine()` when the outer schema is Zod 3
    - `.base64()` and `.base64url()` — available natively in Zod 3, Zod 4, and Zod mini; always prefer the native validator on whichever `z` instance is in scope rather than delegating to another version
    - `.uuidv7()` — available in Zod mini (`zm`) only; use `zm.uuidv7().safeParse(val).success` inside a Zod 3 `.refine()` when validating UUIDv7 format
- **Always call `.trim()` before any further string checks** — in both Zod 3 (`z.string().trim()`) and Zod mini (`zm.string().check(zm.trim())`), `.trim()` must be the first check in the chain so that leading/trailing whitespace never causes a valid value to fail subsequent format or length validators
- **Prefer `.transform()` over manual JS conversion** — when a validated value needs to be reshaped (e.g. stripping UUID hyphens, decoding base64 to hex), chain `.transform()` directly on the Zod schema instead of doing the conversion imperatively in the action/handler body. This keeps the action body free of normalization logic and makes the output type precise. Always ensure the transform is added **after** all validation checks (`.trim()`, `.uuid()`, `.refine()`, etc.) in the chain. Example: `z.string().trim().uuid().toLowerCase().refine(...).transform((uuid) => uuid.replaceAll('-', ''))`
- **Never use `.transform()` for operations Zod has built in** — Zod 3 provides `.trim()`, `.toLowerCase()`, and `.toUpperCase()` as native `ZodString` methods; always prefer those over wrapping the same logic in `.transform()`. Because these are `ZodString` methods (not `ZodEffects`), they must be called **before** `.refine()` in the chain. Example: `z.string().trim().toLowerCase().length(32)` instead of `z.string().trim().length(32).transform((s) => s.toLowerCase())`

#### Import/Export Patterns

```typescript
// Always use type imports when importing only types
import type { SomeType } from './types.mjs';

// Use default exports for main classes/functions
export default class MainClass {}

// Use named exports for utilities
export { HelperClass } from './helpers.mjs';

// Dynamic imports for conditional loading
await import('module').then(({ export }) => {
    // Use imported module
});

// Parallel dynamic imports
await Promise.all([
    import('@hono/zod-validator'),
    import('zod/v4')
]).then(([{ zValidator }, { z: z4 }]) => {
    // Use imported modules
});
```

#### Path Aliases

```typescript
// Use path aliases for imports
'~shared/helpers/index.mjs'; // Shared helpers
'~shared/db-core/db.mjs'; // Database core
'~shared/types/index.mjs'; // Type definitions
'~pqc/do/index.mjs'; // PQC Durable Objects
'~/types.mjs'; // Local types
```

### Database Patterns (Drizzle ORM)

- **Prefer Drizzle inferred model types**: use `table.$inferSelect` and `table.$inferInsert` for row/input typing instead of hardcoded schema-shaped TypeScript interfaces where appropriate.
- **Prefer `Pick<>` / `Omit<>` over manual field typing** when deriving view-model or action-input types from inferred table rows.
- **Avoid per-column `select({ ... })` when not required**: prefer `select().from(table)` and transform with typed `Pick<>`/`Omit<>` unless query performance or join shape requires explicit column selection.

#### Schema Definitions

```typescript
export const tableName = sqliteTable(
	'table_name',
	(t) => ({
		// Primary keys as binary UUIDs
		id: t.blob({ mode: 'buffer' }).primaryKey().notNull(),

		// UTF-8 UUID columns (virtual generated, deprecated for new use)
		id_utf8: t
			.text({ mode: 'text' })
			.generatedAlwaysAs(
				(): SQL =>
					sql<UuidExport['utf8']>`lower(format('%s-%s-%s-%s-%s', 
                    substr(hex(${tableName.id}),1,8), 
                    substr(hex(${tableName.id}),9,4), 
                    substr(hex(${tableName.id}),13,4), 
                    substr(hex(${tableName.id}),17,4), 
                    substr(hex(${tableName.id}),21)))`,
				{ mode: 'virtual' },
			)
			.$type<UuidExport['utf8']>(),

		// Standard fields with proper typing
		created_at: t
			.text({ mode: 'text', length: 24 })
			.notNull()
			.$type<ISODateString>()
			.default(sql`(strftime('%FT%H:%M:%fZ', CURRENT_TIMESTAMP))`),
	}),
	// Constraints
	(table) => [unique().on(table.field1, table.field2)],
);
```

#### Blob Column Writes (Insert / Update)

Drizzle ORM on D1 **cannot accept raw `Buffer` objects** in `.values()` or `.set()` for blob columns. Instead, use `sql`unhex(${hexString})`` which converts a hex-encoded string to a blob at the database level.

```typescript
import { eq, sql } from 'drizzle-orm/sql';

// Insert with blob columns — always use sql`unhex(${hexString})`
db.insert(table).values({
	id: sql`unhex(${uuidHex})`, // hex string → blob
	hash: sql`unhex(${digest.digest('hex')})`, // crypto digest as hex → blob
	do_id: sql`unhex(${randomBytes(16).toString('hex')})`,
});

// Update blob columns
db.update(table)
	.set({ key_hash: sql`unhex(${newHashHex})` })
	.where(eq(table.id, sql`unhex(${idHex})`));

// Where clauses with blob columns
db.select()
	.from(table)
	.where(eq(table.id, sql`unhex(${idHex})`));
```

> **Never** pass `Buffer.from(hex, 'hex')` directly into Drizzle `.values()`, `.set()`, or `eq()` comparisons — use `sql`unhex(${hexString})`` instead.

### API Patterns (Hono)

#### Worker Entry Point

```typescript
export default class extends WorkerEntrypoint<EnvVars> {
	override async fetch(request: Request) {
		const secondaryRequest = request.clone();
		const app = await import('hono').then(({ Hono }) => new Hono<{ Bindings: EnvVars; Variables: ContextVariables }>());

		// Middleware setup...

		return app.fetch(request, this.env, this.ctx);
	}
}
```

#### Middleware Pattern

```typescript
// Security middleware
app.use('*', (c, next) => import('hono/csrf').then(({ csrf }) => csrf()(c, next)));
app.use('*', (c, next) =>
	import('hono/cors').then(({ cors }) =>
		cors({
			origin: '*',
			allowMethods: ['GET', 'OPTIONS'],
			maxAge: 300,
		})(c, next),
	),
);

// Performance middleware
app.use('*', (c, next) => import('hono/etag').then(({ etag }) => etag()(c, next)));

// Debug middleware (development only)
app.use('*', async (c, next) => {
	if (c.env.NODE_ENV === 'development') {
		return import('hono/logger').then(({ logger }) => logger()(c, next));
	}
	await next();
});

// Custom middleware with conditional logic
app.use('*', async (c, next) => {
	if (condition) {
		// Use 'await next()' when continuing the middleware chain
		// Hono builds c.res behind the scenes, no return needed
		await next();
	} else {
		// Return response directly when not continuing
		return c.json({ error: 'Condition not met' }, 403);
	}
});
```

> **Important**: In Hono middleware, use `await next()` (not `return await next()`) when allowing the middleware chain to continue. Hono builds the response (`c.res`) behind the scenes throughout the middleware chain. Only return responses directly when you want to short-circuit the chain.

> **TypeScript Note**: You may need to add `// @ts-expect-error - Hono middleware doesn't need to return when calling await next()` above middleware functions that use `await next()` to suppress false "not all code paths return a value" errors.

### Helper Classes Usage

### Error Handling Patterns

#### API Responses

```typescript
// Consistent error response format
interface ApiResponse<T> {
	success: boolean;
	data?: T;
	errors?: Array<{
		message: string;
		extensions?: { code: number };
	}>;
}
```

#### Async Operations

```typescript
// Prefer promise chains for better DX and granular error handling
return riskyOperation()
	.then((result) => ({ success: true, data: result }))
	.catch((error) => {
		console.error('Operation failed:', error);
		throw new Error('Detailed error message', { cause: error });
	});

// Use try/catch only when promise chains become unwieldy
try {
	const result = await complexMultiStepOperation();
	return { success: true, data: result };
} catch (error) {
	console.error('Operation failed:', error);
	throw new Error('Detailed error message', { cause: error });
}
```

### Security Considerations

#### Sensitive Data Handling

```typescript
// Always redact sensitive information in logs
function redact(str: string, visibleChars: number = 5): string {
    const redactedLength = str.length - 2 * visibleChars;
    const redactedPart = '.'.repeat(redactedLength);
    return [str.slice(0, visibleChars), redactedPart, str.slice(-visibleChars)].join('');
}

// Strip sensitive headers from requests
public static stripSensitiveHeaders(headers: Headers): Headers {
    const sensitiveHeaders = ['authorization', 'cookie', 'x-api-key'];
    const cleaned = new Headers(headers);
    sensitiveHeaders.forEach(header => cleaned.delete(header));
    return cleaned;
}
```

#### Content Security Policy

- Implement comprehensive CSP headers
- Use nonce-based script/style loading when possible
- Restrict unsafe-inline and unsafe-eval usage

### Logging & Debugging

#### Structured Logging

```typescript
// Use chalk for colorized console output in development
if (logger) {
	await import('chalk')
		.then(({ Chalk }) => {
			const chalk = new Chalk({ level: 1 });
			console.debug(chalk.green('Success'), message);
		})
		.catch(() => console.debug('Success', message));
}
```

#### Development vs Production

```typescript
if (c.env.NODE_ENV === 'development') {
	// Development-only logic
	return import('hono/logger').then(({ logger }) => logger()(c, next));
}
```

### Performance Optimization

#### Caching Strategies

```typescript
// Implement intelligent caching with TTL
const cacheRef = caches.open('apiCache');
if (cacheRef && cacheTtl) {
	const cachedResponse = await cache.match(cacheKey);
	if (cachedResponse && cachedResponse.status < 500) {
		return cachedResponse;
	}
}
```

#### Dynamic Imports

```typescript
// Use dynamic imports for conditional loading
await Promise.all([import('@hono/zod-validator'), import('zod/v4')]).then(([{ zValidator }, { z: z4 }]) => {
	// Use imported modules
});
```

## Development Workflow

### Code Generation

- Use Drizzle Kit for database schema generation
- Generate TypeScript types from external APIs (Bitwarden schemas)
- Maintain separate schemas for root and tenant databases

### Testing & Validation

- Use Zod for runtime type validation
- Implement comprehensive input validation for all API endpoints
- Test both local development and Cloudflare Workers environments

### Build & Deployment

- Support both local development (with Wrangler proxy) and production deployment
- Use different configurations for preview and production environments
- Implement proper CI/CD with changesets for version management
- Before running build, lint, typecheck, preview, clean, or codegen commands, inspect the nearest relevant `package.json` scripts first and prefer those scripts over ad hoc tool invocations
- In this monorepo, prefer workspace-targeted npm commands such as `npm -w admin run build:types:tsc` when a package already defines the needed workflow

### Integration Patterns

#### Sidecar Worker Service

```typescript
// Use sidecar worker via service bindings to bypass Qwik/Vite/Pages limitations
// Implement RPC calls from Pages SSR to sidecar worker
// Write sidecar code like normal worker, then trigger via RPC
const sidecarResponse = await env.SIDECAR.fetch(request);
```

#### Bitwarden Secrets Manager

```typescript
// Use sidecar service for Bitwarden integration
// Implement proper secret rotation and management
// Handle authentication and authorization properly
```

#### Post-Quantum Cryptography

```typescript
// Use PQC container for post-quantum operations
// Docker container provides access to Node.js crypto with PQC algorithms
// that aren't available in Cloudflare Worker's node:crypto shim
// Implement proper fallback mechanisms
// Handle PQC-specific error conditions
```

#### Cloudflare Workers/Pages

```typescript
// Use Cloudflare-specific APIs and patterns
// Implement proper edge computing practices
// Handle Cloudflare-specific limitations and features
```

#### Cloudflare Workflows

```typescript
// Each step can be void or must return serializable data
// CF serializes step output to be available for subsequent steps
// Steps must be idempotent - don't rely on external state
await step.do('Step name', async () => {
	// All steps must be async and awaited
	// Return serializable data or void
	return { data: 'value' }; // Will be serialized and available later
});

// Define params using Zod - first step should always parse
export const workflowParams = z4.object({
	t_id: ZodUuidExportInput,
	kr_id: ZodUuidExportInput,
	cursor: z4.string().optional(), // For pagination
	completed: z4.number().default(0), // Track progress
});

export class MyWorkflow extends WorkflowEntrypoint<EnvVars, Params> {
	override async run(event: Readonly<WorkflowEvent<Params>>, step: WorkflowStep) {
		// First step: always parse params with Zod
		const params = await step.do('Parse params', () =>
			workflowParams.parseAsync(typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload).catch((err) => {
				throw new NonRetryableError('Bad workflow payload: ' + JSON.stringify(err));
			}),
		);

		// Make each step granular for effective retry logic
		// Each step = one transaction/unit of work
		const result1 = await step.do('API call 1', async () => {
			// Minimize API calls per step for idempotency
			return await externalApi.call();
		});

		// Parallelize steps wherever possible
		const [result2, result3] = await Promise.all([step.do('Parallel task 1', async () => task1()), step.do('Parallel task 2', async () => task2())]);

		// Step retry logic targeting consistent timeframe (3 days default)
		const criticalData = await step.do(
			'Critical operation',
			{
				retries: {
					limit: 4320, // 3 days = 4320 minutes at 1min intervals
					delay: 60 * 1000, // 1 minute
					backoff: 'constant',
				},
				timeout: 30 * 1000, // CPU limit (default 30s, max 5min)
			},
			async () => {
				return await criticalApiCall();
			},
		);

		// Maximum 1024 steps per instance - use pagination for long workflows
		const finalStep = await step.do('Final step', async () => {
			if (remainingWork) {
				// Preserve state in params for next workflow instance
				return this.env.WORKFLOWS.create({
					id: `${workflowId}-${Date.now()}`,
					params: {
						...params,
						cursor: nextCursor,
						completed: stepCount,
					},
				});
			}
			return { complete: true };
		});
	}
}

// Workflow Logging Best Practices
// Direct console.log() in workflows is not easily visible - you have to check the worker logs
// Instead, prefer these patterns:

// IMPORTANT: NonRetryableError usage
// Only use the first parameter (message) when throwing NonRetryableError
// The second parameter (name) is for internal Cloudflare use only and breaks the error object
// Using it makes the workflow engine treat it as a normal error and retry as defined
// Correct: throw new NonRetryableError('Validation failed: invalid input format');
// Incorrect: throw new NonRetryableError('Validation failed', 'InvalidInput');

// 1. Use descriptive error messages for failures
await step.do('Validate API key', async () => {
	const isValid = await validateKey(apiKey);
	if (!isValid) {
		throw new Error('API key validation failed: key expired or invalid format');
	}
	return { validated: true, keyId: extractKeyId(apiKey) };
});

// 2. Let step output "speak for itself" for success cases
const processedData = await step.do('Process user data', async () => {
	return {
		recordsProcessed: 150,
		errors: [],
		duration: '2.3s',
		nextCursor: 'abc123',
	};
});

// 3. Wrap step output with logging info when needed
const apiResult = await step.do('Call external API', async () => {
	const startTime = Date.now();
	const response = await externalApi.getData();
	const duration = Date.now() - startTime;

	return {
		data: response.data,
		meta: {
			statusCode: response.status,
			duration: `${duration}ms`,
			recordCount: response.data?.length || 0,
			timestamp: new Date().toISOString(),
		},
	};
});
```

### Build & Deployment Patterns

#### Development Environment

- Use Wrangler for local development
- Support both API tokens and direct bindings
- Implement proper environment detection

#### Production Deployment

- Use Cloudflare Workers for API
- Use Cloudflare Pages for frontend
- Implement proper CI/CD with changesets

#### Monorepo Management

- Use Lerna for package management
- Implement shared configurations
- Use consistent build patterns across packages

## Common Patterns to Follow

1. **Always validate inputs** using Zod schemas
2. **Use proper TypeScript typing** for all function parameters and returns
3. **Implement consistent error handling** across all modules
4. **Follow the established file naming conventions** (prefer .mts for TypeScript modules, .ts only for platform constraints like Worker entry points, .tsx for JSX, .mjs for JS configs)
5. **Use the helper classes** (CryptoHelpers, NetHelpers, BufferHelpers) for common operations
6. **Maintain separation of concerns** between API, frontend, and shared code
7. **Document complex cryptographic operations** with detailed comments
8. **Use environment-specific configurations** for different deployment targets
9. **Implement proper logging** with sensitive data redaction
10. **Follow the existing database schema patterns** for UUID handling and timestamps
11. **Use dynamic imports** for conditional module loading
12. **Implement comprehensive middleware** for security, performance, and debugging
13. **Use WorkerEntrypoint** class for Cloudflare Workers entry points
14. **Clone requests** when needed for middleware processing
15. **Use Promise.all** for parallel dynamic imports
16. **Implement proper path aliases** for clean import statements
17. **Use `await next()` in Hono middleware** - never `return await next()` when continuing the chain
18. **Make Workflow steps idempotent** - don't rely on external state outside of step return values
19. **All Workflow steps must be async** - use async functions and await all operations
20. **Make Workflow steps granular** - one API call or unit of work per step for effective retry logic
21. **Return serializable data from Workflow steps** - each step output is serialized by Cloudflare
22. **Limit Workflow steps to 1024 per instance** - use pagination pattern for long-running workflows
23. **Define Workflow params with Zod** - first step should always parse params
24. **Parallelize Workflow steps** - use Promise.all/allSettled/race/any for concurrent operations
25. **Name Workflow steps deterministically** - short, human-readable, and consistent names
26. **Target 3-day retry timeframes** - set retry limits based on delay intervals
27. **Prefer promise chains over try/catch** - use `.then()/.catch()/.finally()` for better DX and granular error handling
28. **Use descriptive errors in Workflow steps** - direct logging isn't easily visible, prefer meaningful error messages
29. **Let Workflow step output speak for itself** - return structured data that shows what happened instead of logging
30. **Wrap step output with meta info when logging is needed** - include timing, counts, and status in return values
31. **Use only first parameter of NonRetryableError** - second parameter (name) is for internal CF use and breaks error handling
32. **Match retry config to API rate limits** - use API-specific delays and backoff patterns in step configurations
33. **Place Qwik components in the `components/` folder** - only actual page files (`index.tsx`) and route-specific utilities (loaders, actions, helpers) belong in `routes/`
34. **Use streaming/deferred `routeLoader$`** for loaders with async I/O — return an `async () => { ... }` function and consume with `<Resource>` to avoid freezing page load
35. **Keep sync setup in the outer `routeLoader$` function** — only move async I/O (DB queries, fetch) into the returned async function
36. **Inspect `package.json` scripts before running commands** - prefer repo-defined npm scripts and pass the correct workspace with `npm -w <workspace> run <script>` instead of invoking `tsc`, `vite`, `wrangler`, or similar tools directly when an equivalent script exists
37. **For UI translations in `workers/customer`**, edit only `workers/customer/messages/en.json`, then run `npm -w customer run translate` to generate/update other locales
38. **For user-facing timestamps**, use semantic `<time>` elements with `dateTime`, display localized time in the user's timezone via `useTimezone()`, and include UTC in the `title` tooltip for hover clarity
39. **For complex permission assignment UIs**, provide a large dedicated surface (full-screen panel or large modal), separate global permissions from per-resource permissions, and include short descriptions explaining what each permission grants
40. **For datetime form inputs**, use `rawTimezone()` server-side to convert the user's local wall-clock input into a UTC `Date` before saving to the database; dates must be stored as UTC and shown back to users in local time with UTC available on hover

### Streaming/Deferred Route Loaders (Qwik)

By default, `routeLoader$` blocks page rendering until complete. To avoid freezing the page, return an **async function** from the loader so Qwik streams the page shell immediately and resolves the data later.

#### Pattern

```typescript
import { Resource, component$ } from '@builder.io/qwik';
import { routeLoader$ } from '@builder.io/qwik-city';

// Return an async function to make the loader streaming/deferred
export const useData = routeLoader$(async (event) => {
	// Synchronous setup (URL params, resolveValue, sharedMap reads) stays in the outer function
	await event.resolveValue(useDependency);
	const db = event.sharedMap.get('db') as Db;

	// Async I/O (DB queries, fetch calls) goes inside the returned function
	return async () => {
		const rows = await db.select().from(table);
		return rows;
	};
});

// Consume with <Resource> instead of direct .value access
export default component$(() => {
	const data = useData();
	return (
		<Resource
			value={data}
			onPending={() => <div>Loading…</div>}
			onResolved={(resolved) => <div>{/* render resolved data */}</div>}
		/>
	);
});
```

#### When to use streaming loaders

- **Use** for loaders that perform async I/O (database queries, fetch calls, external API calls)
- **Don't use** for synchronous/instant loaders (reading `locale()`, platform env values, parsing headers)
- **Don't use** for auth/security loaders that must complete before rendering (JWT validation, access checks)
- **Don't use** for loaders that other loaders depend on via `resolveValue()` (e.g., database initialization loaders)

#### Key rules

- Move only async I/O into the returned function; keep sync setup (URL params, `resolveValue`, `sharedMap` reads) in the outer function
- Replace direct `.value` access in the component with `<Resource>` from `@builder.io/qwik`
- Pass resolved data as parameters to helper functions (e.g., `sortUrl(col, data.sortCol, data.sortDir)`) instead of reading from the loader signal directly
- Provide an `onPending` fallback in `<Resource>` for a loading state

### Workflow Step Retry Configurations

When configuring retries for steps that make API calls, always match the `delay` and `backoff` to the target service's rate limits:

#### Cloudflare APIs

```typescript
retries: {
    limit: 4320, // 3 days at 1-minute intervals
    delay: 1 * 60 * 1000, // 1 minute - matches CF API rate limits
    backoff: 'constant', // CF APIs use constant backoff
}
```

#### Bitwarden Secrets Manager

```typescript
retries: {
    limit: 4320, // 3 days at 1-minute intervals
    delay: 1 * 60 * 1000, // 1 minute - matches rate limit reset interval
    backoff: 'constant', // Rate limits reset at calendar minute boundaries
}
```

#### D1 Database Operations

```typescript
retries: {
    limit: 1440, // 3 days at 3-minute intervals
    delay: 3 * 60 * 1000, // 3 minutes - conservative for database operations
    backoff: 'exponential', // Database congestion benefits from exponential backoff
}
```

#### PQC Container Operations

```typescript
retries: {
    limit: 1440, // 3 days at 3-minute intervals
    delay: 3 * 60 * 1000, // 3 minutes - accounts for container startup time
    backoff: 'exponential', // Container issues often resolve with exponential backoff
}
```

#### CPU-Intensive Operations (Cryptography)

```typescript
{
    timeout: 30 * 1000, // 30 seconds for standard operations
    // timeout: 5 * 60 * 1000, // 5 minutes for PQC operations like SLH-DSA
}
```

## Avoid These Patterns

1. **Don't use while loops** - prefer for...of, map, filter, reduce
2. **Don't hardcode environment-specific values** - use environment variables
3. **Don't log sensitive information** - always redact tokens, keys, and personal data
4. **Don't use any type** - provide proper type definitions
5. **Don't mix .js and .ts extensions** inappropriately - use .mts for modules, .ts only when required by platform, .tsx for JSX, .mjs for configs
6. **Don't bypass the established helper classes** for common operations
7. **Don't create direct database connections** - use the DBManager singleton
8. **Don't use deprecated UUID helpers** - prefer BufferHelpers for new code
9. **Don't skip input validation** - always use Zod for API endpoints
10. **Don't ignore environment checks** - use proper development vs production logic
11. **Don't use blocking imports** - prefer dynamic imports for conditional loading
12. **Don't skip request cloning** when middleware needs to read the body
13. **Don't use `return await next()` in Hono middleware** - use `await next()` when continuing the chain
14. **Don't rely on external state in Workflow steps** - steps must be idempotent using only serialized data
15. **Don't use blocking operations in Workflow steps** - all steps must be async and awaited
16. **Don't put multiple API calls in one Workflow step** - keep steps granular for retry effectiveness
17. **Don't return non-serializable data from Workflow steps** - only primitives, objects, and arrays
18. **Don't exceed 1024 steps in a single Workflow instance** - implement pagination for long operations
19. **Don't nest steps inside steps** - avoid steps within steps due to CPU timeout limits
20. **Don't mutate incoming Workflow events directly** - use step outputs for any mutations
21. **Don't use sync operations in Workflow steps** - everything must be async/awaited
22. **Don't use try/catch when promise chains are clearer** - prefer `.then()/.catch()/.finally()` for better DX and granular error handling
23. **Don't use generic retry configurations for API calls** - always match delay/backoff to the specific API's rate limits
24. **Don't place Qwik components in the `routes/` folder** - the `routes/` folder is only for page files (`index.tsx`) and route-specific server code (loaders, actions, layouts). All reusable components must go in `components/` using the folder-per-component pattern (e.g., `components/my-component/my-component.tsx`)
25. **Don't use blocking `routeLoader$` for async I/O** — return an async function and use `<Resource>` to stream the data without freezing page load
26. **Don't access deferred loader `.value` directly** — use `<Resource>` with `onPending`/`onResolved` callbacks instead
27. **Don't pass raw `Buffer` objects to Drizzle `.values()`, `.set()`, or `eq()` comparisons** — use `sql`unhex(${hexString})`` instead
28. **Don't skip existing package scripts** - avoid direct command invocations when the relevant workspace `package.json` already defines the proper script and workflow
29. **Don't hand-edit non-English customer locale files** - only modify `workers/customer/messages/en.json` and regenerate with `npm -w customer run translate`
30. **Don't use CSS Grid** — always use CSS3 Flexbox for layouts. Grid introduces complexity and unpredictable wrapping with dynamic content; flexbox is simpler and more maintainable.

## Security Notes

This project handles cryptographic operations and sensitive data. Always:

- Validate all inputs thoroughly
- Use proper error handling to prevent information leakage
- Implement comprehensive logging for audit trails
- Follow the principle of least privilege for API access
- Use the established patterns for sensitive data handling
- Ensure proper key rotation and management through Bitwarden integration
- Implement CSRF and CORS protection
- Use content security policies appropriately
