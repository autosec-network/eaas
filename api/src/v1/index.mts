import { OpenAPIHono } from '@hono/zod-openapi';
import { bearerAuth } from 'hono/bearer-auth';
import { bodyLimit } from 'hono/body-limit';
import { contextStorage } from 'hono/context-storage';
import { prettyJSON } from 'hono/pretty-json';
import { requestId } from 'hono/request-id';
import { createHash, randomUUID } from 'node:crypto';
import type { ContextVariables, EnvVars } from '~/types.mjs';

const app = new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>();

// Dev debug injection point
app.use('*', async (c, next) => {
	if (c.env.NODE_ENV === 'development') {
		return next();
	}
});

// Before auth or api routes

app.doc('/openapi', {
	openapi: '3.0.0',
	info: {
		title: 'EaaS API',
		version: '1.0.0',
	},
	security: [
		{
			bearerAuth: [],
		},
	],
});

// Security
app.use(
	'*',
	bearerAuth({
		/**
		 * Use sha512 (default uses sha256)
		 * Use node crypto for optimization
		 */
		hashFunction: (data: string) => createHash('sha512').update(data).digest('hex'),
		verifyToken: async (token, c) => {
			return true;
		},
	}),
);
/**
 * Measured in kb
 * Set to just worker memory limit
 * @link https://developers.cloudflare.com/workers/platform/limits/#worker-limits
 */
app.use(
	'*',
	bodyLimit({
		maxSize: 100 * 1024 * 1024,
		onError: (c) => c.json({ errors: [{ message: 'Content size not supported', extensions: { code: 413 } }] }, 413),
	}),
);

// Performance
app.use('*', contextStorage());

// Debug
app.use(
	'*',
	requestId({
		generator: (c) => c.req.header('CF-Ray')?.split('-')[0] ?? randomUUID(),
	}),
);
app.use('*', prettyJSON());

export default app;
