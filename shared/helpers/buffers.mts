import type { D1Blob, PrefixedUuid, UuidExport } from '../types/d1/index.mjs';
import type { UndefinedProperties } from '../types/index.mjs';
import { CryptoHelpers } from './crypto.mjs';

export class BufferHelpers {
	public static bigintToBuffer(number: bigint): Promise<UuidExport['blob']> {
		const hexString = number.toString(16);
		return this.hexToBuffer(hexString.length % 2 === 0 ? hexString : `0${hexString}`);
	}

	public static bufferToBigint(buffer: UuidExport['blob'] | D1Blob) {
		return this.bufferToHex(buffer).then((hex) => BigInt(`0x${hex}`));
	}

	public static hexToBuffer(hex: UuidExport['hex']): Promise<UuidExport['blob']> {
		return (
			import('node:buffer')
				.then(({ Buffer }) => {
					const mainBuffer = Buffer.from(hex, 'hex');
					return mainBuffer.buffer.slice(mainBuffer.byteOffset, mainBuffer.byteOffset + mainBuffer.byteLength);
				})
				/**
				 * @link https://jsbm.dev/NHJHj31Zwm3OP
				 */
				.catch(() => new Uint8Array(hex.length / 2).map((_, index) => parseInt(hex.slice(index * 2, index * 2 + 2), 16)).buffer)
		);
	}

	public static bufferToHex(buffer: UuidExport['blob'] | D1Blob): Promise<UuidExport['hex']> {
		return (
			import('node:buffer')
				// @ts-expect-error `ArrayBufferLike` or D1Blob is actually accepted and fine
				.then(({ Buffer }) => Buffer.from(buffer).toString('hex'))
				/**
				 * @link https://jsbm.dev/AoXo8dEke1GUg
				 */
				// @ts-expect-error `ArrayBufferLike` or D1Blob is actually accepted and fine
				.catch(() => new Uint8Array(buffer).reduce((output, elem) => output + ('0' + elem.toString(16)).slice(-2), ''))
		);
	}

	public static base64ToBuffer(rawBase64: string, urlSafe: boolean): Promise<UuidExport['blob']> {
		return import('node:buffer')
			.then(({ Buffer }) => {
				const mainBuffer = Buffer.from(rawBase64, urlSafe ? 'base64url' : 'base64');
				return mainBuffer.buffer.slice(mainBuffer.byteOffset, mainBuffer.byteOffset + mainBuffer.byteLength);
			})
			.catch(() => {
				let base64 = rawBase64;
				if (urlSafe) {
					base64 = rawBase64.replaceAll('-', '+').replaceAll('_', '/');
					// Add padding back to make length a multiple of 4
					while (base64.length % 4 !== 0) {
						base64 += '=';
					}
				}

				return new TextEncoder().encode(atob(base64)).buffer;
			});
	}

	public static bufferToBase64(buffer: UuidExport['blob'] | D1Blob, urlSafe: boolean): Promise<string> {
		return (
			import('node:buffer')
				// @ts-expect-error `ArrayBufferLike` or D1Blob is actually accepted and fine
				.then(({ Buffer }) => Buffer.from(buffer).toString(urlSafe ? 'base64url' : 'base64'))
				.catch(() => {
					// @ts-expect-error `ArrayBufferLike` is actually accepted and fine
					const raw = btoa(new TextDecoder().decode(buffer));
					if (urlSafe) {
						return raw.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
					} else {
						return raw;
					}
				})
		);
	}

	public static get generateUuid(): Promise<UuidExport> {
		return Promise.all([CryptoHelpers.secretBytes(16), import('uuid')]).then(([random, { v7: uuidv7 }]) => {
			const uuid = uuidv7({ random }) as UuidExport['utf8'];
			const uuidHex = uuid.replaceAll('-', '');

			return this.hexToBuffer(uuidHex).then((blob) =>
				this.bufferToBase64(blob, false).then((base64) => ({
					utf8: uuid,
					hex: uuidHex,
					blob,
					base64,
				})),
			);
		});
	}

	public static uuidConvert(input: undefined): Promise<UndefinedProperties<UuidExport>>;
	public static uuidConvert(prefixedUtf: PrefixedUuid): Promise<UuidExport>;
	public static uuidConvert(input: UuidExport['utf8']): Promise<UuidExport>;
	public static uuidConvert(input: UuidExport['hex']): Promise<UuidExport>;
	public static uuidConvert(input: UuidExport['blob']): Promise<UuidExport>;
	public static uuidConvert(input: D1Blob): Promise<UuidExport>;
	public static uuidConvert(input: UuidExport['base64']): Promise<UuidExport>;
	// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
	public static uuidConvert(input?: PrefixedUuid | UuidExport['utf8'] | UuidExport['hex'] | UuidExport['blob'] | D1Blob | UuidExport['base64']): Promise<UuidExport | UndefinedProperties<UuidExport>> {
		if (input) {
			if (typeof input === 'string') {
				if (input.includes('-')) {
					let hex = input.replaceAll('-', '');

					if (input.includes('_')) {
						input = input.split('_')[1]!;
						hex = hex.split('_')[1]!;
					}

					return this.hexToBuffer(hex).then((blob) =>
						this.bufferToBase64(blob, false).then((base64) => ({
							utf8: input as UuidExport['utf8'],
							hex,
							blob,
							base64,
						})),
					);
					/**
					 * @link https://base64.guru/standards/base64url
					 */
				} else if (new RegExp(/^[a-z\d_-]+$/i).test(input)) {
					const base64: UuidExport['base64'] = input;

					return this.base64ToBuffer(base64, base64.includes('_')).then((blob) =>
						this.bufferToHex(blob).then((hex) => ({
							utf8: `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}`,
							hex,
							blob,
							base64,
						})),
					);
				} else {
					const hex: UuidExport['hex'] = input;

					return this.hexToBuffer(hex).then((blob) =>
						this.bufferToBase64(blob, false).then((base64) => ({
							utf8: `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}`,
							hex,
							blob,
							base64,
						})),
					);
				}
			} else {
				return Promise.all([this.bufferToHex(input), this.bufferToBase64(input, false)]).then(([hex, base64]) => ({
					utf8: `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}`,
					hex,
					// @ts-expect-error `ArrayBufferLike` or D1Blob is actually accepted and fine
					blob: new Uint8Array(input).buffer,
					base64,
				}));
			}
		} else {
			// eslint-disable-next-line @typescript-eslint/require-await
			return (async () => ({
				utf8: undefined,
				hex: undefined,
				blob: undefined,
				base64: undefined,
			}))();
		}
	}
}
