import { z } from '@hono/zod-openapi';

/**
 * Base error schema for unified API responses
 */
export const apiErrorSchema = z.object({
	code: z.number().int().optional().openapi({ example: 400 }),
	message: z.string().openapi({ example: 'Error message' }),
	cause: z.string().optional().openapi({ example: 'Root cause of the error' }),
});

/**
 * Unified API response schema that wraps all API responses
 */
export const unifiedResponseSchema = <T extends z.ZodTypeAny>(responseSchema?: T) =>
	z.object({
		success: z.boolean().openapi({ example: true }),
		errors: z.array(apiErrorSchema).openapi({ example: [] }),
		response: responseSchema?.optional(),
	});

/**
 * Error-only unified response schema for error cases
 */
export const errorResponseSchema = z.object({
	success: z.literal(false).openapi({ example: false }),
	errors: z
		.array(apiErrorSchema)
		.min(1)
		.openapi({
			example: [{ code: 400, message: 'Validation failed' }],
		}),
});

/**
 * Success-only unified response schema
 */
export const successResponseSchema = <T extends z.ZodTypeAny>(responseSchema: T) =>
	z.object({
		success: z.literal(true).openapi({ example: true }),
		errors: z.array(apiErrorSchema).length(0).openapi({ example: [] }),
		response: responseSchema,
	});

/**
 * Helper to create OpenAPI responses that document the unified format
 * while allowing handlers to return the original format (for transformation middleware)
 */
export const createUnifiedOpenAPIResponses = <T extends z.ZodTypeAny>(successSchema: T, customErrorResponses?: Record<number, { description: string }>) => ({
	200: {
		description: 'Success',
		content: {
			'application/json': {
				schema: successResponseSchema(successSchema),
			},
		},
	},
	400: {
		description: 'Bad Request',
		content: {
			'application/json': {
				schema: errorResponseSchema,
			},
		},
	},
	401: {
		description: 'Unauthorized',
		content: {
			'application/json': {
				schema: errorResponseSchema,
			},
		},
	},
	403: {
		description: 'Forbidden',
		content: {
			'application/json': {
				schema: errorResponseSchema,
			},
		},
	},
	404: {
		description: 'Not Found',
		content: {
			'application/json': {
				schema: errorResponseSchema,
			},
		},
	},
	413: {
		description: 'Content Too Large',
		content: {
			'application/json': {
				schema: errorResponseSchema,
			},
		},
	},
	422: {
		description: 'Unprocessable Entity',
		content: {
			'application/json': {
				schema: errorResponseSchema,
			},
		},
	},
	500: {
		description: 'Internal Server Error',
		content: {
			'application/json': {
				schema: errorResponseSchema,
			},
		},
	},
	...customErrorResponses,
});

/**
 * Helper to document that all responses use the unified format
 * but still allow the TypeScript types to work correctly
 * This should be used as additional documentation in the route description
 */
export const unifiedResponseNote = `

**Note**: All responses are wrapped in a unified format:
\`\`\`json
{
  "success": boolean,
  "errors": Array<{ code?: number, message: string, cause?: string }>,
  "response"?: <actual_response_data>
}
\`\`\`

The schema shown below represents the content of the \`response\` field when \`success: true\`.
`;
