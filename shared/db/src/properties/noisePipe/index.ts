import * as zm from 'zod/mini';
import * as z4 from 'zod/v4';

const arrayBuffer32 = zm.instanceof(ArrayBuffer).check(zm.refine((buf) => buf.byteLength === 32));
const arrayBuffer32_4 = z4.instanceof(ArrayBuffer).refine((buf) => buf.byteLength === 32);

export const NoisePipePropertiesSchema = zm.object({
	phase: zm.enum(['awaiting_msg1', 'awaiting_msg3', 'transport']),

	// Server static keypair (from tenant context)
	s_static_public: arrayBuffer32,
	s_static_private: arrayBuffer32,

	// Server ephemeral keypair (generated per pipe)
	s_ephemeral_public: zm.optional(arrayBuffer32),
	s_ephemeral_private: zm.optional(arrayBuffer32),

	// Remote (client) keys — populated during handshake
	r_ephemeral_public: zm.optional(arrayBuffer32),
	r_static_public: zm.optional(arrayBuffer32),

	// Handshake intermediate state (cleared after split)
	handshake_hash: zm.optional(arrayBuffer32),
	chaining_key: zm.optional(arrayBuffer32),
	cipher_key: zm.optional(zm.nullable(arrayBuffer32)),
	cipher_nonce: zm.optional(zm.number().check(zm.int(), zm.minimum(0))),

	// Transport cipher states (populated after handshake completion)
	tx_key: zm.optional(arrayBuffer32),
	tx_nonce: zm.optional(zm.int().check(zm.nonnegative())),
	rx_key: zm.optional(arrayBuffer32),
	rx_nonce: zm.optional(zm.int().check(zm.nonnegative())),
});
// eslint-disable-next-line zod/require-schema-suffix
export const NoisePipePropertiesSchema4 = z4.object({
	phase: z4.enum(['awaiting_msg1', 'awaiting_msg3', 'transport']),

	// Server static keypair (from tenant context)
	s_static_public: arrayBuffer32_4,
	s_static_private: arrayBuffer32_4,

	// Server ephemeral keypair (generated per pipe)
	s_ephemeral_public: arrayBuffer32_4.optional(),
	s_ephemeral_private: arrayBuffer32_4.optional(),

	// Remote (client) keys — populated during handshake
	r_ephemeral_public: arrayBuffer32_4.optional(),
	r_static_public: arrayBuffer32_4.optional(),

	// Handshake intermediate state (cleared after split)
	handshake_hash: arrayBuffer32_4.optional(),
	chaining_key: arrayBuffer32_4.optional(),
	cipher_key: arrayBuffer32_4.nullable().optional(),
	cipher_nonce: z4.int().nonnegative().optional(),

	// Transport cipher states (populated after handshake completion)
	tx_key: arrayBuffer32_4.optional(),
	tx_nonce: z4.int().nonnegative().optional(),
	rx_key: arrayBuffer32_4.optional(),
	rx_nonce: z4.int().nonnegative().optional(),
});
