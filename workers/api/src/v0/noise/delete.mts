import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { ContextVariables, EnvVars } from '~/types.mjs';
import { APITags } from '~/v0/extras.mjs';

const app = new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>();

// ─── DELETE /:pipeId — Tear Down Pipe ────────────────────────────────────────

const deleteRoute = createRoute({
	tags: [APITags['Noise Pipe']],
	method: 'delete',
	path: '/:pipeId',
	description: 'Tear down a noise pipe immediately, destroying all session state.',
	request: {
		params: z.object({
			pipeId: z.string().min(1).describe('Pipe ID'),
		}),
	},
	responses: {
		200: {
			content: {
				'application/json': {
					schema: z.object({
						success: z.boolean(),
					}),
				},
			},
			description: 'Pipe destroyed',
		},
	},
});

app.openapi(deleteRoute, (c) => {
	const { pipeId } = c.req.valid('param');

	const pipeDo = c.env.NOISE_PIPE.get(c.env.NOISE_PIPE.idFromString(pipeId));
	c.executionCtx.waitUntil(pipeDo.nuke('Client requested teardown'));

	return c.json({ success: true });
});

export default app;
