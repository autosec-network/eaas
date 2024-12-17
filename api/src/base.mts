import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { bodyLimit } from 'hono/body-limit';
import { contextStorage } from 'hono/context-storage';
import { prettyJSON } from 'hono/pretty-json';
import type { TimingVariables } from 'hono/timing';
import { createHash } from 'node:crypto';
import type { EnvVars } from '~/types.mjs';
import api1 from '~/v0/index.mjs';

const app = new Hono<{ Bindings: EnvVars; Variables: TimingVariables }>();

// Security
app.use('*', (c, next) => {
	if (new RegExp(/^\/v\d+\/openapi3?\/?$/i).test(c.req.path)) {
		return next();
	} else if (new RegExp(/^\/v\d+\/v\d+\.cf-aig.openapi.json$/i).test(c.req.path)) {
		return next();
	} else {
		return bearerAuth({
			/**
			 * Use sha512 (default uses sha256)
			 * Use node crypto for optimization
			 */
			hashFunction: (data: string) => createHash('sha512').update(data).digest('hex'),
			verifyToken: async (token, c) => {
				return true;
			},
		})(c, next);
	}
});
/**
 * Measured in kb
 * Set to just worker memory limit
 * @link https://developers.cloudflare.com/workers/platform/limits/#worker-limits
 */
app.use(
	'*',
	bodyLimit({
		maxSize: 100 * 1024 * 1024,
		onError: (c) => c.json({ success: false, errors: [{ message: 'Content size not supported', extensions: { code: 413 } }] }, 413),
	}),
);

// Performance
app.use('*', contextStorage());

// Debug
app.use('*', prettyJSON());

// All api versions go here
app.route('/v0', api1);

export default app;
