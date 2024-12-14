import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import isHexadecimal from 'validator/es/lib/isHexadecimal';
import type { ContextVariables, EnvVars } from '~/types.mjs';
import { workersCryptoCatalog } from '~shared/types/crypto/workers-crypto-catalog.mjs';

const app = new OpenAPIHono<{ Bindings: EnvVars; Variables: ContextVariables }>();

const example = 'Hello world';

const input = z.discriminatedUnion('format', [
	z.object({
		input: z
			.string()
			.refine((value) => isHexadecimal(value))
			.openapi({ example: Buffer.from(example).toString('hex') }),
		format: z.literal('hex'),
		reference: z.string().optional(),
	}),
	z.object({
		input: z.union([
			z
				.string()
				.base64()
				.openapi({ example: Buffer.from(example).toString('base64') }),
			z
				.string()
				.base64url()
				.openapi({ example: Buffer.from(example).toString('base64url') }),
		]),
		format: z.literal('base64'),
		reference: z.string().optional(),
	}),
]);

const output = z.object({
	value: z
		.string()
		.refine((value) => isHexadecimal(value))
		.openapi({
			example: createHash('sha256').update(Buffer.from(example)).digest('hex'),
		}),
	reference: z.string().optional(),
});

export const route = createRoute({
	method: 'post',
	path: '/{algorithm}',
	request: {
		params: z.object({
			algorithm: z.enum(workersCryptoCatalog.hashes).openapi({
				param: {
					name: 'algorithm',
					in: 'path',
					example: 'sha256',
				},
			}),
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
							result: z.union([output, z.array(output)]),
						})
						.openapi('HashOutput'),
				},
			},
			description: 'Retrieve the user',
		},
	},
});

app.openapi(route, (c) => {
	// Needs to be set to a variable or else type isn't inferred
	const json = c.req.valid('json');
	/**
	 * @link https://base64.guru/standards/base64url
	 */
	const base64TypeCheck = new RegExp(/^[a-z0-9_-]+$/i);

	if ('batch_input' in json) {
		return c.json(
			{
				success: true,
				result: json.batch_input.map(({ input, format, reference }) => ({
					value: createHash(c.req.param('algorithm'))
						.update(Buffer.from(input, format === 'base64' ? (base64TypeCheck.test(input) ? 'base64url' : 'base64') : format))
						.digest('hex'),
					reference,
				})),
			},
			200,
		);
	} else {
		return c.json(
			{
				success: true,
				result: {
					value: createHash(c.req.param('algorithm'))
						.update(Buffer.from(json.input, json.format === 'base64' ? (base64TypeCheck.test(json.input) ? 'base64url' : 'base64') : json.format))
						.digest('hex'),
					reference: json.reference,
				},
			},
			200,
		);
	}
});

export default app;
