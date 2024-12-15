import { OpenAPIHono } from '@hono/zod-openapi';
import packageJson from '~/../package.json';
import type { ContextVariables, EnvVars } from '~/types.mjs';
import hash from '~/v0/hash.mjs';
import random from '~/v0/random.mjs';

const app = new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>({
	defaultHook: (result, c) => {
		if (!result.success) {
			return c.json({ success: result.success, errors: [{ message: result.error.message, extensions: { code: 400 } }] }, 400);
		}
	},
});

// Before auth or api routes
app.doc31('/openapi', (c) => ({
	openapi: '3.1.0',
	info: {
		title: 'EaaS API',
		// description: 'Description',
		// termsOfService: 'https://example.com',
		contact: {
			name: 'Issues',
			url: 'https://github.com/autosec-network/eaas/issues',
		},
		version: packageJson.version,
	},
	servers: [
		{
			url: c.req.path
				.split('/')
				.splice(0, c.req.path.split('/').length - 1)
				.join('/'),
		},
	],
	security: [
		{
			ApiToken: [],
		},
	],
}));

app.openAPIRegistry.registerComponent('securitySchemes', 'ApiToken', {
	type: 'http',
	scheme: 'bearer',
});

app.route('/random', random);
app.route('/hash', hash);

export default app;
