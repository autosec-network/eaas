import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { Buffer } from 'node:buffer';
import type { ContextVariables, EnvVars } from '~/types.mjs';
import { APITags, flexKeySchema } from '~/v0/extras.mjs';

const app = new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>();

// ─── PUT /:pipeId — Finalize Handshake (Msg 3) ──────────────────────────────

const finalizeRoute = createRoute({
	tags: [APITags['Noise Pipe']],
	method: 'put',
	path: '/:pipeId',
	description: 'Finalize the Noise_XX handshake by sending message 3 (-> s, se). After this, the pipe is in transport mode.',
	request: {
		params: z.object({
			pipeId: z.string().min(1).describe('Pipe ID from the init response'),
		}),
		body: {
			content: {
				'application/json': {
					schema: z.object({
						message: flexKeySchema.describe('Handshake message 3 (hex/base64/base64url)'),
					}),
				},
			},
		},
	},
	responses: {
		200: {
			content: {
				'application/json': {
					schema: z.object({
						success: z.boolean(),
						handshake_hash: z.base64url().describe('Handshake hash for channel binding (base64url-encoded)'),
						payload: z.base64url().optional().describe('Decrypted payload from message 3 (if any)'),
					}),
				},
			},
			description: 'Handshake complete, pipe in transport mode',
		},
	},
});

app.openapi(finalizeRoute, async (c) => {
	const { pipeId } = c.req.valid('param');
	const { message } = c.req.valid('json');

	const pipeDo = c.env.NOISE_PIPE.get(c.env.NOISE_PIPE.idFromString(pipeId));

	// message is already a Buffer from flexKeySchema
	const result = await pipeDo.handleMessage3(message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength));

	const payloadBuf = Buffer.from(result.payload);

	return c.json({
		success: true,
		handshake_hash: Buffer.from(result.handshakeHash).toString('base64url'),
		...(payloadBuf.length > 0 && { payload: payloadBuf.toString('base64url') }),
	});
});

export default app;
