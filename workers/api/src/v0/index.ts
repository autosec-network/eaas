import { OpenAPIHono } from '@hono/zod-openapi';
import type { oas31 } from 'openapi3-ts';
import { version } from '~/../package.json';
import { problemJsonValidation } from '~/errors';
import type { ContextVariables, EnvVars } from '~/types';
import apikeys from '~/v0/apikeys/index';
import gss from '~/v0/gss/index';
import keyrings from '~/v0/keyrings/index';
import random from '~/v0/random';
import stats from '~/v0/stats/index';

// import decrypt from '~/v0/decrypt';
// import encrypt from '~/v0/encrypt';
// import hash from '~/v0/hash';

const app = new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>({
	defaultHook: (result, c) => {
		if (!result.success) {
			return problemJsonValidation(c, result.error);
		}
	},
});

const title = 'EaaS API';
const description = '***Undergoing rearchitect/rewrite***\n\nInspired by Hashicorp Vault Transit, powered by Bitwarden Secrets Manager, node:crypto, and Web Crypto and runs fully on Cloudflare Workers. No data stored - just key management with pass-through encrypt/decrypt, and optional per-request wrapping for MITM/TLS inspection compliance.';
// const termsOfService = 'https://example.com';
const contact: oas31.ContactObject = {
	name: 'Issues',
	url: 'https://github.com/autosec-network/eaas/issues',
};

// Before auth or api routes
app.doc31('/generate/openapi31', (c) => ({
	openapi: '3.1.0',
	info: {
		title,
		description,
		contact,
		version,
	},
	servers: [
		{
			url: c.req.path
				.split('/')
				.splice(0, c.req.path.split('/').length - 2)
				.join('/'),
		},
	],
	security: [
		{
			ApiToken: [],
		},
	],
}));
app.doc('/generate/openapi', (c) => ({
	openapi: '3.0.0',
	info: {
		title,
		description,
		contact,
		version,
	},
	servers: [
		{
			url: c.req.path
				.split('/')
				.splice(0, c.req.path.split('/').length - 2)
				.join('/'),
		},
	],
	security: [
		{
			ApiToken: [],
		},
	],
}));
app.doc('/generate/v0.eaas.cf-apig.openapi', {
	openapi: '3.0.0',
	info: {
		title,
		description,
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

app.openAPIRegistry.registerComponent('securitySchemes', 'GithubPublicKeyIdentifier', {
	type: 'apiKey',
	in: 'header',
	name: 'Github-Public-Key-Identifier',
});
app.openAPIRegistry.registerComponent('securitySchemes', 'GithubPublicKeySignature', {
	type: 'apiKey',
	in: 'header',
	name: 'Github-Public-Key-Signature',
});
app.route('/gss', gss);

app.openAPIRegistry.registerComponent('securitySchemes', 'ApiToken', {
	type: 'http',
	scheme: 'bearer',
});
app.route('/apikeys', apikeys);
app.route('/keyrings', keyrings);
app.route('/random', random);
app.route('/stats', stats);

// app.route('/encrypt', encrypt);
// app.route('/decrypt', decrypt);
// app.route('/hash', hash);

export default app;
