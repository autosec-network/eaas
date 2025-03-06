import type { oas31 } from 'openapi3-ts';
import type { ContextVariables, EnvVars } from '~/types.mjs';

const app = await import('@hono/zod-openapi').then(
	({ OpenAPIHono }) =>
		new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>({
			defaultHook: (result, c) => {
				if (!result.success) {
					return c.json({ success: result.success, errors: [{ message: result.error.message, extensions: { code: 400 } }] }, 400);
				}
			},
		}),
);

const title = 'EaaS API';
// const description = 'Description';
// const termsOfService = 'https://example.com';
const contact: oas31.ContactObject = {
	name: 'Issues',
	url: 'https://github.com/autosec-network/eaas/issues',
};

// Before auth or api routes
await import('~/../package.json').then(({ version }) => {
	app.doc31('/openapi31', (c) => ({
		openapi: '3.1.0',
		info: {
			title,
			contact,
			version,
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
			version,
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
			version,
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
});

app.openAPIRegistry.registerComponent('securitySchemes', 'ApiToken', {
	type: 'http',
	scheme: 'bearer',
});

await import('~/v0/keyrings/index.mjs').then(({ default: keyrings }) => app.route('/keyrings', keyrings));
await import('~/v0/encrypt.mjs').then(({ default: encrypt }) => app.route('/encrypt', encrypt));
await import('~/v0/hash.mjs').then(({ default: hash }) => app.route('/hash', hash));
await import('~/v0/random.mjs').then(({ default: random }) => app.route('/random', random));

export default app;
