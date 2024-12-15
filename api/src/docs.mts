import { swaggerUI } from '@hono/swagger-ui';
import { Hono } from 'hono';
import { cache } from 'hono/cache';
import { cors } from 'hono/cors';
import type { TimingVariables } from 'hono/timing';
import type { EnvVars } from '~/types.mjs';

const app = new Hono<{ Bindings: EnvVars; Variables: TimingVariables }>();

// Security
app.use('*', cors({ origin: '*', allowMethods: ['GET', 'OPTIONS'], maxAge: 300 }));

// Performance
app.use(
	'*',
	cache({
		cacheName: 'eaas-api-docs',
		// days * hours * minutes * seconds
		cacheControl: ['public', `max-age=${1 * 24 * 60 * 60}`, `s-maxage=${1 * 24 * 60 * 60}`].join(', '),
	}),
);

app.get('/', (c, next) => {
	const pathSegments = c.req.path.split('/');
	return swaggerUI({
		url: [...pathSegments.splice(0, pathSegments.length - 1), 'openapi'].join('/'),
		deepLinking: true,
		displayRequestDuration: true,
		filter: true,
		tryItOutEnabled: true,
		requestSnippetsEnabled: true,
	})(c, next);
});

export default app;
