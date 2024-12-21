import { OpenAPIHono } from '@hono/zod-openapi';
import type { oas31 } from 'openapi3-ts';
import packageJson from '~/../package.json';
import type { ContextVariables, EnvVars } from '~/types.mjs';
import encrypt from '~/v0/encrypt.mjs';
import hash from '~/v0/hash.mjs';
import random from '~/v0/random.mjs';

const app = new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>({
	defaultHook: (result, c) => {
		if (!result.success) {
			return c.json({ success: result.success, errors: [{ message: result.error.message, extensions: { code: 400 } }] }, 400);
		}
	},
});

const title = 'EaaS API';
// const description = 'Description';
// const termsOfService = 'https://example.com';
const contact: oas31.ContactObject = {
	name: 'Issues',
	url: 'https://github.com/autosec-network/eaas/issues',
};

// Before auth or api routes
app.doc31('/openapi31', (c) => ({
	openapi: '3.1.0',
	info: {
		title,
		contact,
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
app.doc('/openapi', (c) => ({
	openapi: '3.0.0',
	info: {
		title,
		contact,
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
app.doc('/v0.cf-aig.openapi.json', {
	openapi: '3.0.0',
	info: {
		title,
		contact,
		version: packageJson.version,
	},
	servers: [
		{
			url: new URL('v0', 'https://api.eaas.autosec.network').toString(),
		},
		{
			url: new URL('v0', 'https://{hostvar1}.api.eaas.autosec.network').toString(),
			variables: {
				hostvar1: {
					default: 'preview',
				},
			},
		},
	],
	security: [
		{
			ApiToken: [],
		},
	],
});

app.openAPIRegistry.registerComponent('securitySchemes', 'ApiToken', {
	type: 'http',
	scheme: 'bearer',
});

app.route('/encrypt', encrypt);
app.route('/hash', hash);
app.route('/random', random);

export default app;
