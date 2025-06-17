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
// Comprehensive error handling
try {
	const result = await riskyOperation();
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
