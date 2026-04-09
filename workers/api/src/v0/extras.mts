import { z } from '@hono/zod-openapi';
import { Buffer } from 'node:buffer';

export enum APITags {
	Free = 'Free',
	Stats = 'Stats',
	'API Key Management' = 'API Key Management',
	'Keyring Management' = 'Keyring Management',
	'Noise Pipe' = 'Noise Pipe',
}

/** Accept hex, base64, or base64url encoded binary and decode to Buffer */
export const flexKeySchema = z.union([z.hex().transform((v) => Buffer.from(v, 'hex')), z.base64().transform((v) => Buffer.from(v, 'base64')), z.base64url().transform((v) => Buffer.from(v, 'base64url'))]);

/** flexKeySchema constrained to exactly 32 bytes (X25519 keys etc.) */
export const flexKey32Schema = flexKeySchema.refine((buf) => buf.byteLength === 32, 'Must be exactly 32 bytes');
