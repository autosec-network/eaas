/**
 * Noise Protocol Framework implementation: Noise_XX_25519_ChaChaPoly_SHA256
 *
 * Uses exclusively `node:crypto` for all cryptographic operations.
 * @see https://noiseprotocol.org/noise.html
 */
import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync } from 'node:crypto';

// ─── Constants ───────────────────────────────────────────────────────────────

const HASHLEN = 32; // SHA-256 output length
const DHLEN = 32; // X25519 key length
const TAGLEN = 16; // Poly1305 tag length
const MAX_NONCE = 2 ** 64 - 1;

const PROTOCOL_NAME = 'Noise_XX_25519_ChaChaPoly_SHA256';

/**
 * DER-encoded PKCS#8 prefix for X25519 private keys.
 * The last 32 bytes are the raw private key wrapped in an OCTET STRING.
 */
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

/**
 * DER-encoded SPKI prefix for X25519 public keys.
 * The last 32 bytes are the raw public key.
 */
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

// ─── Key Types ───────────────────────────────────────────────────────────────

export interface KeyPair {
	publicKey: Buffer;
	privateKey: Buffer;
}

// ─── X25519 Helpers ──────────────────────────────────────────────────────────

export function generateX25519Keypair(): KeyPair {
	const { publicKey, privateKey } = generateKeyPairSync('x25519');
	return {
		publicKey: publicKey.export({ type: 'spki', format: 'der' }).subarray(-DHLEN) as Buffer,
		privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-DHLEN) as Buffer,
	};
}

function wrapPrivateKey(raw: Buffer) {
	return createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, raw]), format: 'der', type: 'pkcs8' });
}

function wrapPublicKey(raw: Buffer) {
	return createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

export function x25519DH(myPrivateRaw: Buffer, theirPublicRaw: Buffer): Buffer {
	return diffieHellman({ privateKey: wrapPrivateKey(myPrivateRaw), publicKey: wrapPublicKey(theirPublicRaw) }) as Buffer;
}

// ─── Hash / HKDF ─────────────────────────────────────────────────────────────

function sha256(...parts: Buffer[]): Buffer {
	const h = createHash('sha256');
	for (const p of parts) h.update(p);
	return h.digest() as Buffer;
}

/**
 * Noise HKDF: produces 2 or 3 output keys of HASHLEN each.
 * @see https://noiseprotocol.org/noise.html#hash-functions
 */
function noiseHKDF(chainingKey: Buffer, inputKeyMaterial: Buffer, numOutputs: 2): [Buffer, Buffer];
function noiseHKDF(chainingKey: Buffer, inputKeyMaterial: Buffer, numOutputs: 3): [Buffer, Buffer, Buffer];
function noiseHKDF(chainingKey: Buffer, inputKeyMaterial: Buffer, numOutputs: 2 | 3): Buffer[] {
	// hkdfSync(hash, ikm, salt, info, keylen)
	// In Noise: salt = chainingKey, ikm = inputKeyMaterial
	const okm = Buffer.from(hkdfSync('sha256', inputKeyMaterial, chainingKey, '', numOutputs * HASHLEN));
	const outputs: Buffer[] = [];
	for (let i = 0; i < numOutputs; i++) {
		outputs.push(okm.subarray(i * HASHLEN, (i + 1) * HASHLEN) as Buffer);
	}
	return outputs;
}

// ─── CipherState ─────────────────────────────────────────────────────────────

export class CipherState {
	k: Buffer | null;
	n: number;

	constructor(k: Buffer | null = null, n: number = 0) {
		this.k = k;
		this.n = n;
	}

	hasKey(): boolean {
		return this.k !== null;
	}

	private nonce(): Buffer {
		if (this.n > MAX_NONCE) throw new Error('Nonce exhausted');
		// Noise spec: 4 bytes zero || 8 bytes LE counter
		const buf = Buffer.alloc(12);
		buf.writeUInt32LE(this.n & 0xffffffff, 4);
		buf.writeUInt32LE(Math.floor(this.n / 0x100000000) & 0xffffffff, 8);
		return buf;
	}

	encryptWithAd(ad: Buffer, plaintext: Buffer): Buffer {
		if (!this.k) return plaintext;

		const nonce = this.nonce();
		const cipher = createCipheriv('chacha20-poly1305', this.k, nonce, { authTagLength: TAGLEN });
		cipher.setAAD(ad, { plaintextLength: plaintext.length });

		const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
		const tag = cipher.getAuthTag();
		this.n++;
		return Buffer.concat([encrypted, tag]);
	}

	decryptWithAd(ad: Buffer, ciphertext: Buffer): Buffer {
		if (!this.k) return ciphertext;

		if (ciphertext.length < TAGLEN) throw new Error('Ciphertext too short');

		const ct = ciphertext.subarray(0, -TAGLEN);
		const tag = ciphertext.subarray(-TAGLEN);
		const nonce = this.nonce();

		const decipher = createDecipheriv('chacha20-poly1305', this.k, nonce, { authTagLength: TAGLEN });
		decipher.setAAD(ad, { plaintextLength: ct.length });
		decipher.setAuthTag(tag);

		const decrypted = Buffer.concat([decipher.update(ct), decipher.final()]);
		this.n++;
		return decrypted as Buffer;
	}

	serialize(): { k: ArrayBuffer | null; n: number } {
		return { k: this.k ? (this.k.buffer.slice(this.k.byteOffset, this.k.byteOffset + this.k.byteLength) as ArrayBuffer) : null, n: this.n };
	}

	static deserialize(data: { k: ArrayBuffer | null; n: number }): CipherState {
		return new CipherState(data.k ? Buffer.from(data.k) : null, data.n);
	}
}

// ─── SymmetricState ──────────────────────────────────────────────────────────

export class SymmetricState {
	ck: Buffer; // chaining key
	h: Buffer; // handshake hash
	cs: CipherState;

	constructor() {
		this.ck = Buffer.alloc(HASHLEN);
		this.h = Buffer.alloc(HASHLEN);
		this.cs = new CipherState();
	}

	initializeSymmetric(protocolName: string): void {
		const nameBuf = Buffer.from(protocolName, 'ascii');
		if (nameBuf.length <= HASHLEN) {
			this.h = Buffer.alloc(HASHLEN);
			nameBuf.copy(this.h);
		} else {
			this.h = sha256(nameBuf);
		}
		this.ck = Buffer.from(this.h);
		this.cs = new CipherState();
	}

	mixKey(inputKeyMaterial: Buffer): void {
		const [newCk, tempK] = noiseHKDF(this.ck, inputKeyMaterial, 2);
		this.ck = newCk;
		this.cs = new CipherState(tempK, 0);
	}

	mixHash(data: Buffer): void {
		this.h = sha256(this.h, data);
	}

	encryptAndHash(plaintext: Buffer): Buffer {
		const ciphertext = this.cs.encryptWithAd(this.h, plaintext);
		this.mixHash(ciphertext);
		return ciphertext;
	}

	decryptAndHash(ciphertext: Buffer): Buffer {
		const plaintext = this.cs.decryptWithAd(this.h, ciphertext);
		this.mixHash(ciphertext);
		return plaintext;
	}

	split(): [CipherState, CipherState] {
		const [tempK1, tempK2] = noiseHKDF(this.ck, Buffer.alloc(0), 2);
		return [new CipherState(tempK1, 0), new CipherState(tempK2, 0)];
	}

	serialize(): { ck: ArrayBuffer; h: ArrayBuffer; cs: ReturnType<CipherState['serialize']> } {
		return {
			ck: this.ck.buffer.slice(this.ck.byteOffset, this.ck.byteOffset + this.ck.byteLength) as ArrayBuffer,
			h: this.h.buffer.slice(this.h.byteOffset, this.h.byteOffset + this.h.byteLength) as ArrayBuffer,
			cs: this.cs.serialize(),
		};
	}

	static deserialize(data: { ck: ArrayBuffer; h: ArrayBuffer; cs: ReturnType<CipherState['serialize']> }): SymmetricState {
		const ss = new SymmetricState();
		ss.ck = Buffer.from(data.ck);
		ss.h = Buffer.from(data.h);
		ss.cs = CipherState.deserialize(data.cs);
		return ss;
	}
}

// ─── HandshakeState ──────────────────────────────────────────────────────────

/**
 * Noise_XX pattern:
 *   -> e
 *   <- e, ee, s, es
 *   -> s, se
 */
export class HandshakeState {
	private ss: SymmetricState;
	private s: KeyPair; // local static
	private e: KeyPair | null; // local ephemeral
	private rs: Buffer | null; // remote static public
	private re: Buffer | null; // remote ephemeral public
	private initiator: boolean;
	private msgIndex: number;

	constructor(initiator: boolean, s: KeyPair, prologue: Buffer = Buffer.alloc(0)) {
		this.ss = new SymmetricState();
		this.ss.initializeSymmetric(PROTOCOL_NAME);
		this.ss.mixHash(prologue);

		this.s = s;
		this.e = null;
		this.rs = null;
		this.re = null;
		this.initiator = initiator;
		this.msgIndex = 0;
	}

	/**
	 * Write the next handshake message.
	 * @param payload Optional plaintext payload to encrypt in the message.
	 * @returns The serialized message buffer.
	 */
	writeMessage(payload: Buffer = Buffer.alloc(0)): Buffer {
		const parts: Buffer[] = [];

		if (this.initiator) {
			if (this.msgIndex === 0) {
				// -> e
				this.e = generateX25519Keypair();
				parts.push(this.e.publicKey);
				this.ss.mixHash(this.e.publicKey);
				parts.push(this.ss.encryptAndHash(payload));
			} else if (this.msgIndex === 2) {
				// -> s, se
				parts.push(this.ss.encryptAndHash(this.s.publicKey));
				this.ss.mixKey(x25519DH(this.s.privateKey, this.re!));
				parts.push(this.ss.encryptAndHash(payload));
			} else {
				throw new Error(`Unexpected initiator write at msgIndex ${this.msgIndex}`);
			}
		} else {
			if (this.msgIndex === 1) {
				// <- e, ee, s, es
				this.e = generateX25519Keypair();
				parts.push(this.e.publicKey);
				this.ss.mixHash(this.e.publicKey);
				this.ss.mixKey(x25519DH(this.e.privateKey, this.re!)); // ee
				parts.push(this.ss.encryptAndHash(this.s.publicKey)); // s (encrypted)
				this.ss.mixKey(x25519DH(this.s.privateKey, this.re!)); // es
				parts.push(this.ss.encryptAndHash(payload));
			} else {
				throw new Error(`Unexpected responder write at msgIndex ${this.msgIndex}`);
			}
		}

		this.msgIndex++;
		return Buffer.concat(parts);
	}

	/**
	 * Read a handshake message from the peer.
	 * @returns The decrypted payload and, if the handshake is done, the transport CipherStates.
	 */
	readMessage(message: Buffer): { payload: Buffer; tx?: CipherState; rx?: CipherState } {
		let offset = 0;
		const read = (n: number) => {
			const slice = message.subarray(offset, offset + n);
			offset += n;
			return slice;
		};
		const readRest = () => message.subarray(offset);

		let payload: Buffer;

		if (this.initiator) {
			if (this.msgIndex === 1) {
				// <- e, ee, s, es
				this.re = read(DHLEN);
				this.ss.mixHash(this.re);
				this.ss.mixKey(x25519DH(this.e!.privateKey, this.re)); // ee
				this.rs = this.ss.decryptAndHash(read(DHLEN + TAGLEN)); // s (encrypted)
				this.ss.mixKey(x25519DH(this.e!.privateKey, this.rs)); // es
				payload = this.ss.decryptAndHash(readRest());
			} else {
				throw new Error(`Unexpected initiator read at msgIndex ${this.msgIndex}`);
			}
		} else {
			if (this.msgIndex === 0) {
				// -> e
				this.re = read(DHLEN);
				this.ss.mixHash(this.re);
				payload = this.ss.decryptAndHash(readRest());
			} else if (this.msgIndex === 2) {
				// -> s, se
				this.rs = this.ss.decryptAndHash(read(DHLEN + TAGLEN)); // s (encrypted)
				this.ss.mixKey(x25519DH(this.e!.privateKey, this.rs)); // se
				payload = this.ss.decryptAndHash(readRest());
			} else {
				throw new Error(`Unexpected responder read at msgIndex ${this.msgIndex}`);
			}
		}

		this.msgIndex++;

		// After 3 messages (indices 0,1,2 → msgIndex becomes 3), handshake is complete
		if (this.msgIndex === 3) {
			const [c1, c2] = this.ss.split();
			// Initiator: c1 = send, c2 = receive
			// Responder: c1 = receive, c2 = send
			if (this.initiator) {
				return { payload, tx: c1, rx: c2 };
			} else {
				return { payload, tx: c2, rx: c1 };
			}
		}

		return { payload };
	}

	/**
	 * Get the current handshake hash (for channel binding after handshake completes).
	 */
	getHandshakeHash(): Buffer {
		return Buffer.from(this.ss.h);
	}

	// ─── Serialization for DO storage ────────────────────────────────────

	serialize(): HandshakeStateSerialized {
		const toAB = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
		return {
			ss: this.ss.serialize(),
			s_public: toAB(this.s.publicKey),
			s_private: toAB(this.s.privateKey),
			e_public: this.e ? toAB(this.e.publicKey) : null,
			e_private: this.e ? toAB(this.e.privateKey) : null,
			rs: this.rs ? toAB(this.rs) : null,
			re: this.re ? toAB(this.re) : null,
			initiator: this.initiator,
			msgIndex: this.msgIndex,
		};
	}

	static deserialize(data: HandshakeStateSerialized): HandshakeState {
		const hs = Object.create(HandshakeState.prototype) as HandshakeState;
		hs.ss = SymmetricState.deserialize(data.ss);
		hs.s = { publicKey: Buffer.from(data.s_public), privateKey: Buffer.from(data.s_private) };
		hs.e = data.e_public && data.e_private ? { publicKey: Buffer.from(data.e_public), privateKey: Buffer.from(data.e_private) } : null;
		hs.rs = data.rs ? Buffer.from(data.rs) : null;
		hs.re = data.re ? Buffer.from(data.re) : null;
		hs.initiator = data.initiator;
		hs.msgIndex = data.msgIndex;
		return hs;
	}
}

export interface HandshakeStateSerialized {
	ss: ReturnType<SymmetricState['serialize']>;
	s_public: ArrayBuffer;
	s_private: ArrayBuffer;
	e_public: ArrayBuffer | null;
	e_private: ArrayBuffer | null;
	rs: ArrayBuffer | null;
	re: ArrayBuffer | null;
	initiator: boolean;
	msgIndex: number;
}

export interface TransportState {
	tx: ReturnType<CipherState['serialize']>;
	rx: ReturnType<CipherState['serialize']>;
	handshakeHash: ArrayBuffer;
}
