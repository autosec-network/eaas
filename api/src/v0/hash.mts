import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { endTime, startTime } from 'hono/timing';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import isHexadecimal from 'validator/es/lib/isHexadecimal';
import type { ContextVariables, EnvVars } from '~/types.mjs';
import { workersCryptoCatalog } from '~shared/types/crypto/workers-crypto-catalog.mjs';

const app = new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>();

app.use('*', async (c, next) => {
	if (c.get('permissions').r_hash) {
		await next();
	} else {
		console.log("Token doesn't have permissions");
		return c.json({ success: false, errors: [{ message: 'Access Denied: You do not have permission to perform this action', extensions: { code: 403 } }] }, 403);
	}
});

const example = 'Hello world';

const input = z.discriminatedUnion('format', [
	z.object({
		input: z
			.string()
			.refine((value) => isHexadecimal(value))
			.describe('Specifies the hex encoded input data')
			.openapi({ example: Buffer.from(example).toString('hex') }),
		format: z.literal('hex').describe('Specifies the input encoding'),
		reference: z.string().optional().describe('An optional string that will be present in the reference field on the corresponding item in the response, to assist in understanding which result corresponds to a particular input'),
	}),
	z.object({
		input: z.union([
			z
				.string()
				.base64()
				.describe('Specifies the base64 encoded input data')
				.openapi({ example: Buffer.from(example).toString('base64') }),
			z
				.string()
				.base64url()
				.describe('Specifies the base64url encoded input data')
				.openapi({ example: Buffer.from(example).toString('base64url') }),
		]),
		format: z.literal('base64').describe('Specifies the input encoding'),
		reference: z.string().optional().describe('An optional string that will be present in the reference field on the corresponding item in the response, to assist in understanding which result corresponds to a particular input'),
	}),
]);

const output = z.object({
	value: z
		.string()
		.refine((value) => isHexadecimal(value))
		.describe('The hash of the input data, hex encoded.')
		.openapi({ example: createHash('sha256').update(Buffer.from(example)).digest('hex') }),
	reference: z.string().optional().describe('The value of the `reference` field from the corresponding item in the request'),
});

export const route = createRoute({
	method: 'post',
	path: '/{algorithm}',
	description: 'This endpoint returns the cryptographic hash of given data using the specified algorithm',
	request: {
		params: z.object({
			algorithm: z.enum(workersCryptoCatalog.hashes).describe('Specifies the hash algorithm to use').openapi({ example: 'sha256' }),
		}),
		body: {
			content: {
				'application/json': {
					schema: z
						.union([
							z.object({
								batch_input: z.array(input).nonempty(),
							}),
							input,
						])
						.openapi('HashInput'),
				},
			},
		},
	},
	responses: {
		200: {
			content: {
				'application/json': {
					schema: z
						.object({
							success: z.boolean(),
							result: z.union([z.array(output), output]),
						})
						.openapi('HashOutput'),
				},
			},
			description: 'Returns the cryptographic hash',
		},
	},
});

app.openapi(route, (c) => {
	// Needs to be set to a variable or else type isn't inferred
	const json = c.req.valid('json');
	/**
	 * @link https://base64.guru/standards/base64url
	 */
	const base64TypeCheck = new RegExp(/^[a-z\d_-]+$/i);

	if ('batch_input' in json) {
		return c.json(
			{
				success: true,
				result: json.batch_input.map((item) => {
					const { input, format, reference } = item;

					startTime(c, `hashItem-${reference ?? json.batch_input.indexOf(item)}`);
					const value = createHash(c.req.param('algorithm'))
						.update(Buffer.from(input, format === 'base64' ? (base64TypeCheck.test(input) ? 'base64url' : 'base64') : format))
						.digest('hex');
					endTime(c, `hashItem-${reference ?? json.batch_input.indexOf(item)}`);

					return {
						value,
						reference,
					};
				}),
			},
			200,
		);
	} else {
		startTime(c, 'hashItem');
		const value = createHash(c.req.param('algorithm'))
			.update(Buffer.from(json.input, json.format === 'base64' ? (base64TypeCheck.test(json.input) ? 'base64url' : 'base64') : json.format))
			.digest('hex');
		endTime(c, 'hashItem');

		return c.json(
			{
				success: true,
				result: {
					value,
					reference: json.reference,
				},
			},
			200,
		);
	}
});

export default app;
