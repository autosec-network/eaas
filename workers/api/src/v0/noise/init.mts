import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { Buffer } from 'node:buffer';
import type { ContextVariables, EnvVars } from '~/types.mjs';
import { APITags, flexKey32Schema, flexKeySchema } from '~/v0/extras.mjs';
import { bwAccessToken, bwEndpoints, storeNoisePrivateKeyInBw } from './shared.mjs';

const app = new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>();

// ─── POST / — Initiate Pipe (Handshake Msg 1 → Msg 2) ──────────────────────

const initRoute = createRoute({
	tags: [APITags['Noise Pipe']],
	method: 'post',
	path: '/',
	description: 'Initiate a Noise_XX_25519_ChaChaPoly_SHA256 pipe. Sends handshake message 1 (-> e) and receives message 2 (<- e, ee, s, es).',
	request: {
		body: {
			content: {
				'application/json': {
					schema: z.object({
						ephemeral_public: flexKey32Schema.describe('Client ephemeral X25519 public key (32 bytes, hex/base64/base64url)'),
						payload: flexKeySchema.optional().describe('Optional plaintext payload to encrypt in the handshake'),
						ttl: z.int().positive().max(3600).optional().describe('Requested pipe TTL in seconds (capped at server max)'),
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
						pipe_id: z.string().describe('Durable Object ID for this pipe'),
						message: z.base64url().describe('Handshake message 2 (base64url-encoded)'),
						server_static_public: z.base64url().describe('Server static X25519 public key (base64url-encoded)'),
					}),
				},
			},
			description: 'Pipe created, handshake message 2 returned',
		},
	},
});

app.openapi(initRoute, async (c) => {
	const { ephemeral_public, payload, ttl } = c.req.valid('json');

	// ephemeral_public is already a 32-byte Buffer from flexKey32Schema
	const clientEphemeralBuf = ephemeral_public;

	// Get tenant DO
	const tenantDoId = c.var.t_jurisdiction ? c.env.TENANT_D0.jurisdiction(c.var.t_jurisdiction).idFromString(c.var.t_do_id) : c.env.TENANT_D0.idFromString(c.var.t_do_id);
	const tenantDo = c.env.TENANT_D0.get(tenantDoId);

	// Get or generate the server static keypair
	const keyResult = await tenantDo.getNoiseStaticPublicKey();
	let serverStaticPrivate: ArrayBuffer;

	if (keyResult.isNew) {
		// First time — store private key in Bitwarden
		try {
			const noiseBwId = await storeNoisePrivateKeyInBw(c.executionCtx, c.env, c.var.t_jurisdiction, c.var.t_id.base64url, keyResult.privateKey);
			await tenantDo.updateProperties({ noise_bw: noiseBwId }, false, true);
		} catch (error) {
			// BW persistence failed — roll back the public key so next attempt re-generates
			await tenantDo.deleteNoiseStaticKey(c.var.t_jurisdiction);
			throw error;
		}
		serverStaticPrivate = keyResult.privateKey;
	} else {
		// Existing key — retrieve private key from Bitwarden
		const { noise_bw } = await tenantDo.getProperties({ noise_bw: true }, true);

		if (!noise_bw) {
			// Recovery: public key exists but BW ref is missing — re-generate
			await tenantDo.deleteNoiseStaticKey(c.var.t_jurisdiction);
			const freshKey = await tenantDo.getNoiseStaticPublicKey();
			if (!freshKey.isNew) throw new Error('Unexpected: key still exists after deletion');

			try {
				const noiseBwId = await storeNoisePrivateKeyInBw(c.executionCtx, c.env, c.var.t_jurisdiction, c.var.t_id.base64url, freshKey.privateKey);
				await tenantDo.updateProperties({ noise_bw: noiseBwId }, false, true);
			} catch (error) {
				await tenantDo.deleteNoiseStaticKey(c.var.t_jurisdiction);
				throw error;
			}
			serverStaticPrivate = freshKey.privateKey;
			// Update reference to the fresh public key
			keyResult.publicKey = freshKey.publicKey;
		} else {
			// Retrieve private key from Bitwarden
			const bwDoId = c.var.t_jurisdiction ? c.env.BITWARDEN_SESSION.jurisdiction(c.var.t_jurisdiction).newUniqueId() : c.env.BITWARDEN_SESSION.newUniqueId();
			const bwStub = c.env.BITWARDEN_SESSION.get(bwDoId);

			try {
				await bwStub.init({
					t_jurisdiction: null,
					t_do_id: null,
					endpoints: bwEndpoints(c.var.t_jurisdiction),
				});

				const rootAccessToken = bwAccessToken(c.env, c.var.t_jurisdiction);
				await bwStub.auth(rootAccessToken);

				const [secret] = await bwStub.getSecrets([noise_bw]);
				if (!secret) throw new Error('Noise private key secret not found in Bitwarden');

				const { data: privKeyBase64url } = await bwStub.decryptSecret(rootAccessToken, secret.value, true);
				const buf = Buffer.from(privKeyBase64url, 'base64url');
				serverStaticPrivate = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
			} finally {
				c.executionCtx.waitUntil(bwStub.nuke('Noise key retrieve session ended'));
			}
		}
	}

	// Create NoisePipe DO
	const pipeDoId = c.env.NOISE_PIPE.newUniqueId();
	const pipeDo = c.env.NOISE_PIPE.get(pipeDoId);

	// Initialize pipe
	await pipeDo.init({
		serverStaticPublic: keyResult.publicKey,
		serverStaticPrivate,
		ttl,
	});

	// Process handshake message 1
	const payloadAB = payload ? payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) : undefined;
	const result = await pipeDo.handleMessage1(clientEphemeralBuf.buffer.slice(clientEphemeralBuf.byteOffset, clientEphemeralBuf.byteOffset + clientEphemeralBuf.byteLength), payloadAB);

	return c.json({
		success: true,
		pipe_id: pipeDoId.toString(),
		message: Buffer.from(result.message).toString('base64url'),
		server_static_public: Buffer.from(result.serverStaticPublic).toString('base64url'),
	});
});

export default app;
