import type { Request } from '@cloudflare/workers-types/experimental';

export function isLocal(incoming: string | URL | Request): boolean {
	let incomingUrl: URL;

	if (typeof incoming === 'string' || incoming instanceof URL) {
		incomingUrl = new URL(incoming);
	} else {
		incomingUrl = new URL(incoming.headers.get('origin') ?? incoming.url);
	}

	if (incomingUrl.hostname === 'localhost' || incomingUrl.hostname === '127.0.0.1') {
		return true;
	}

	const parts = incomingUrl.hostname.split('.').map((part) => parseInt(part, 10));

	if (parts.length !== 4) {
		// Not a valid IPv4 address
		return false;
	}

	if (parts[0] === 10) {
		// Class A private IP
		return true;
	}

	if (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) {
		// Class B private IP
		return true;
	}

	if (parts[0] === 192 && parts[1] === 168) {
		// Class C private IP
		return true;
	}

	return false;
}
export function runningLocally(incomingRequest: Request): boolean {
	return isLocal(new URL(incomingRequest.headers.get('Origin') ?? `https://${incomingRequest.headers.get('Host')}`));
}

const LOWER_CHAR_SET = 'abcdefghijklmnopqrstuvwxyz' as const;
const NUMBER_CHAR_SET = '0123456789' as const;
const CHAR_SET = `${LOWER_CHAR_SET.toUpperCase()}${LOWER_CHAR_SET}${NUMBER_CHAR_SET}` as const;
export function randomText(length: number) {
	const randomBytes = new Uint8Array(length);
	crypto.getRandomValues(randomBytes);
	let randomText = '';
	for (const byte of randomBytes) {
		// Map each byte to a character in the character set
		const charIndex = byte % CHAR_SET.length;
		randomText += CHAR_SET.charAt(charIndex);
	}
	return randomText;
}

/**
 * @link https://jsbm.dev/NHJHj31Zwm3OP
 */
export function bufferFromHex(hex: string) {
	return new Uint8Array(hex.length / 2).map((_, index) => parseInt(hex.slice(index * 2, index * 2 + 2), 16)).buffer;
}

/**
 * @link https://jsbm.dev/AoXo8dEke1GUg
 */
export function bufferToHex(buffer: ReturnType<typeof bufferFromHex>) {
	return new Uint8Array(buffer).reduce((output, elem) => output + ('0' + elem.toString(16)).slice(-2), '');
}

export function getHash(algorithm: 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512', input: string | ArrayBufferLike) {
	return crypto.subtle.digest(algorithm, typeof input === 'string' ? new TextEncoder().encode(input) : input).then((hashBuffer) => bufferToHex(hashBuffer));
}

/**
 * @returns Fully formatted (double quote encapsulated) `ETag` header value
 * @link https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/ETag#etag_value
 */
export function generateETag(response: Response, algorithm: Parameters<typeof getHash>[0] = 'SHA-512') {
	return response
		.clone()
		.arrayBuffer()
		.then((buffer) => getHash(algorithm, buffer).then((hex) => `"${hex}"`));
}
