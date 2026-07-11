import { DurableObject } from 'cloudflare:workers';
import { NoisePipePropertiesSchema } from 'db';
import { CipherState, HandshakeState, type HandshakeStateSerialized, type KeyPair } from 'helpers/noise';
import { Buffer } from 'node:buffer';
import type { ObjectValues } from 'types';
import type { ZodPick } from 'types/zod/mini';
import * as zm from 'zod/mini';
import type { EnvVars } from '~/types.mjs';

export class NoisePipe extends DurableObject<EnvVars> {
	public static initOptions = zm.object({
		serverStaticPublic: zm.instanceof(ArrayBuffer).check(zm.refine((buf) => buf.byteLength === 32, 'Server static public key must be 32 bytes')),
		serverStaticPrivate: zm.instanceof(ArrayBuffer).check(zm.refine((buf) => buf.byteLength === 32, 'Server static private key must be 32 bytes')),
		ttl: zm.optional(zm.number().check(zm.int(), zm.positive(), zm.maximum(3600))),
	});

	/**
	 * Initialize a new noise pipe with the server's static keypair and set TTL alarm.
	 */
	public async init(_options: zm.input<typeof NoisePipe.initOptions>) {
		const options = await NoisePipe.initOptions.parseAsync(_options);

		const maxTtl = parseInt(this.env.NOISE_PIPE_TTL, 10);
		const ttl = options.ttl ? Math.min(options.ttl, maxTtl) : maxTtl;

		await this.updateProperties(
			{
				phase: 'awaiting_msg1',
				s_static_public: options.serverStaticPublic,
				s_static_private: options.serverStaticPrivate,
			},
			false,
			true,
		);

		this.ctx.waitUntil(this.ctx.storage.setAlarm(Date.now() + ttl * 1000, { allowConcurrency: true }));
	}

	/**
	 * Process handshake message 1 from initiator (-> e) and produce message 2 (<- e, ee, s, es).
	 */
	public async handleMessage1(clientEphemeralPublic: ArrayBuffer, payload?: ArrayBuffer): Promise<{ message: ArrayBuffer; serverStaticPublic: ArrayBuffer }> {
		const props = await this.getProperties({ phase: true, s_static_public: true, s_static_private: true }, true);

		if (props.phase !== 'awaiting_msg1') {
			throw new Error(`Invalid phase: expected awaiting_msg1, got ${props.phase}`);
		}

		const serverStatic: KeyPair = {
			publicKey: Buffer.from(props.s_static_public!),
			privateKey: Buffer.from(props.s_static_private!),
		};

		// Create responder handshake state
		const hs = new HandshakeState(false, serverStatic);

		// Read message 1: -> e
		const msg1 = Buffer.concat([Buffer.from(clientEphemeralPublic), ...(payload ? [Buffer.from(payload)] : [])]);
		hs.readMessage(msg1);

		// Write message 2: <- e, ee, s, es
		const msg2 = hs.writeMessage();

		// Serialize and store handshake state for message 3
		const serialized = hs.serialize();
		await this.ctx.storage.put({ handshake_state: serialized }, { allowConcurrency: true });
		await this.updateProperties({ phase: 'awaiting_msg3' }, false, true);

		return {
			message: msg2.buffer.slice(msg2.byteOffset, msg2.byteOffset + msg2.byteLength) as ArrayBuffer,
			serverStaticPublic: props.s_static_public!,
		};
	}

	/**
	 * Process handshake message 3 from initiator (-> s, se) and complete the handshake.
	 */
	public async handleMessage3(msg3: ArrayBuffer): Promise<{ payload: ArrayBuffer; handshakeHash: ArrayBuffer }> {
		const props = await this.getProperties({ phase: true }, true);

		if (props.phase !== 'awaiting_msg3') {
			throw new Error(`Invalid phase: expected awaiting_msg3, got ${props.phase}`);
		}

		const serialized = await this.ctx.storage.get<HandshakeStateSerialized>('handshake_state', { allowConcurrency: true });
		if (!serialized) throw new Error('Handshake state not found');

		const hs = HandshakeState.deserialize(serialized);

		// Read message 3: -> s, se
		const result = hs.readMessage(Buffer.from(msg3));

		if (!result.tx || !result.rx) {
			throw new Error('Handshake did not complete');
		}

		const handshakeHash = hs.getHandshakeHash();

		// Store transport cipher states
		const txSerialized = result.tx.serialize();
		const rxSerialized = result.rx.serialize();
		await this.updateProperties(
			{
				phase: 'transport',
				tx_key: txSerialized.k ?? undefined,
				tx_nonce: txSerialized.n,
				rx_key: rxSerialized.k ?? undefined,
				rx_nonce: rxSerialized.n,
			},
			false,
			true,
		);

		// Clean up handshake state
		await this.ctx.storage.delete(['handshake_state', 's_ephemeral_public', 's_ephemeral_private', 'r_ephemeral_public', 'handshake_hash', 'chaining_key', 'cipher_key', 'cipher_nonce'], { allowConcurrency: true });

		return {
			payload: result.payload.buffer.slice(result.payload.byteOffset, result.payload.byteOffset + result.payload.byteLength) as ArrayBuffer,
			handshakeHash: handshakeHash.buffer.slice(handshakeHash.byteOffset, handshakeHash.byteOffset + handshakeHash.byteLength) as ArrayBuffer,
		};
	}

	/**
	 * Encrypt plaintext using the transport sending CipherState.
	 */
	public async encrypt(plaintext: ArrayBuffer, ad?: ArrayBuffer): Promise<ArrayBuffer> {
		const props = await this.getProperties({ phase: true, tx_key: true, tx_nonce: true }, true);

		if (props.phase !== 'transport') {
			throw new Error(`Cannot encrypt: pipe in phase ${props.phase}, expected transport`);
		}

		const cs = new CipherState(props.tx_key ? Buffer.from(props.tx_key) : null, props.tx_nonce ?? 0);
		const ciphertext = cs.encryptWithAd(ad ? Buffer.from(ad) : Buffer.alloc(0), Buffer.from(plaintext));

		await this.updateProperties({ tx_nonce: cs.n }, false, true);

		return ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength) as ArrayBuffer;
	}

	/**
	 * Decrypt ciphertext using the transport receiving CipherState.
	 */
	public async decrypt(ciphertext: ArrayBuffer, ad?: ArrayBuffer): Promise<ArrayBuffer> {
		const props = await this.getProperties({ phase: true, rx_key: true, rx_nonce: true }, true);

		if (props.phase !== 'transport') {
			throw new Error(`Cannot decrypt: pipe in phase ${props.phase}, expected transport`);
		}

		const cs = new CipherState(props.rx_key ? Buffer.from(props.rx_key) : null, props.rx_nonce ?? 0);
		const plaintext = cs.decryptWithAd(ad ? Buffer.from(ad) : Buffer.alloc(0), Buffer.from(ciphertext));

		await this.updateProperties({ rx_nonce: cs.n }, false, true);

		return plaintext.buffer.slice(plaintext.byteOffset, plaintext.byteOffset + plaintext.byteLength) as ArrayBuffer;
	}

	// ─── Properties (following TenantD0 pattern) ─────────────────────────

	public async getProperties(_keys?: ZodPick<typeof NoisePipePropertiesSchema>, lazy: boolean = true): Promise<Partial<zm.output<typeof NoisePipePropertiesSchema>>> {
		return zm
			.pipe(
				zm._default(
					zm.object(
						Object.keys(NoisePipePropertiesSchema.def.shape).reduce(
							(acc, key) => {
								acc[key as keyof typeof NoisePipePropertiesSchema.def.shape] = zm._default(zm.boolean(), false);
								return acc;
							},
							{} as Record<keyof typeof NoisePipePropertiesSchema.def.shape, zm.ZodMiniDefault<zm.ZodMiniBoolean>>,
						),
					),
					Object.keys(NoisePipePropertiesSchema.def.shape).reduce(
						(acc, key) => {
							acc[key as keyof typeof NoisePipePropertiesSchema.def.shape] = true;
							return acc;
						},
						{} as Record<keyof typeof NoisePipePropertiesSchema.def.shape, true>,
					),
				),
				zm.transform((obj) => {
					return Object.fromEntries(Object.entries(obj).filter(([, v]) => v === true)) as Record<keyof typeof NoisePipePropertiesSchema.def.shape, true>;
				}),
			)
			.parseAsync(_keys)
			.then((keys) =>
				this.ctx.storage
					.get<ObjectValues<zm.output<typeof NoisePipePropertiesSchema>>>(
						Object.entries(keys).map(([key]) => key),
						{ allowConcurrency: lazy },
					)
					.then((kv) => zm.pick(NoisePipePropertiesSchema, keys).parseAsync(Object.fromEntries(kv.entries()))),
			);
	}

	public updateProperties(_properties: Partial<zm.input<typeof NoisePipePropertiesSchema>>, background: boolean = false, lazy: boolean = true): Promise<Partial<zm.output<typeof NoisePipePropertiesSchema>>> {
		return zm
			.partial(NoisePipePropertiesSchema)
			.parseAsync(_properties)
			.then(async (properties) => {
				const savingPromise = this.ctx.storage.put(properties, { allowConcurrency: lazy });
				if (background) {
					this.ctx.waitUntil(savingPromise);
				} else {
					await savingPromise;
				}

				return properties;
			});
	}

	// ─── Lifecycle ───────────────────────────────────────────────────────

	override async alarm() {
		await this.nuke('Pipe TTL expired');
	}

	public async nuke(reason?: string) {
		if (reason) console.warn(reason);
		await this.ctx.storage.deleteAll();
		// To ensure that the DO is fully evicted, this.ctx.abort() is called
		// `ctx.abort` throws an uncatchable error, so we yield to the event loop to avoid capturing it and let handlers finish cleaning up
		setTimeout(() => {
			try {
				this.ctx.abort(`nuked${reason ? `: ${reason}` : ''}`);
				// eslint-disable-next-line @typescript-eslint/no-unused-vars
			} catch (error) {
				// Do nothing
			}
		}, 0);
	}
}
