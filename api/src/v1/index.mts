import { OpenAPIHono } from '@hono/zod-openapi';
import type { ContextVariables, EnvVars } from '~/types.mjs';

const app = new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>({
	defaultHook: (result, c) => {
		if (!result.success) {
			return c.json({ success: result.success, errors: [{ message: result.error.message, extensions: { code: 400 } }] }, 400);
		}
	},
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

export default app;
