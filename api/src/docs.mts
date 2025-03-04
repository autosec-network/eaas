import type { ContextVariables, EnvVars } from '~/types.mjs';

const app = await import('hono').then(({ Hono }) => new Hono<{ Bindings: EnvVars; Variables: ContextVariables }>());

// Security
app.use('*', (c, next) =>
	import('hono/cors').then(({ cors }) =>
		cors({
			origin: '*',
			allowMethods: ['GET', 'OPTIONS'],
			maxAge: 300,
		})(c, next),
	),
);

// Performance
app.use('*', (c, next) =>
	import('hono/cache').then(({ cache }) =>
		cache({
			cacheName: 'eaas-api-docs',
			// days * hours * minutes * seconds
			cacheControl: ['public', `max-age=${1 * 24 * 60 * 60}`, `s-maxage=${1 * 24 * 60 * 60}`].join(', '),
		})(c, next),
	),
);

app.get('/', (c, next) => {
	const pathSegments = c.req.path.split('/');

	return import('@hono/swagger-ui').then(({ swaggerUI }) =>
		swaggerUI({
			url: [...pathSegments.splice(0, pathSegments.length - 1), 'openapi31'].join('/'),
			deepLinking: true,
			displayRequestDuration: true,
			filter: true,
			tryItOutEnabled: true,
			requestSnippetsEnabled: true,
		})(c, next),
	);
});

export default app;
