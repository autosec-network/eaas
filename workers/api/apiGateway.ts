import { Cloudflare } from 'cloudflare';
import type { PublicSchema } from 'cloudflare/resources/schema-validation.mjs';
import type { OperationBulkEditParams, OperationListResponse } from 'cloudflare/resources/schema-validation/settings/operations';
import { readdir, readFile } from 'node:fs/promises';
import * as zm from 'zod/mini';

const { CF_API_TOKEN, ZONE_ID } = await zm
	.object({
		CF_API_TOKEN: zm.string().check(zm.trim(), zm.minLength(1)),
		ZONE_ID: zm.hex().check(zm.maxLength(32)),
	})
	.parseAsync(process.env);

const cf = new Cloudflare({ apiToken: CF_API_TOKEN });

const [oldSchemas, fileRoutes] = await Promise.all([
	(async () => {
		console.info('Getting existing schemas on API Gateway');

		const schemas: Record<string, Omit<PublicSchema, 'name'>[]> = {};

		for await (const { name, ...schema } of cf.schemaValidation.schemas.list({
			zone_id: ZONE_ID,
			omit_source: true,
			/**
			 * @link https://developers.cloudflare.com/api/resources/schema_validation/subresources/schemas/methods/list/
			 */
			per_page: 50,
		})) {
			schemas[name] = [...(schemas[name] ?? []), schema].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
		}

		return schemas;
	})(),
	(async () => {
		console.info('Getting generated schemas to upload');

		return readdir('dist', { withFileTypes: true });
	})()
		.then((entries) =>
			entries
				// Get only directories
				.filter((entry) => entry.isDirectory())
				// Get only the name
				.map((dir) => dir.name),
		)
		.then((routes) =>
			Promise.all(
				routes.map((route) =>
					readdir(['dist', route].join('/'), { withFileTypes: true }).then((entries) =>
						entries
							// Get only directories
							.filter((entry) => entry.isFile())
							// Get only cf api gateway files
							.filter((file) => file.name.endsWith('cf-apig.openapi.json'))
							// Get only the name
							.map((file) => ({
								parent: ['dist', route].join('/'),
								name: file.name,
							})),
					),
				),
			),
		)
		.then((fileRoutes) => fileRoutes.flat()),
]);

console.debug(
	'Existing schemas on API Gateway',
	Object.assign(
		Object.entries(oldSchemas).map(([name, schemas]) => ({
			[name]: schemas.length,
		})),
	),
);
console.debug('Schemas to upload', fileRoutes);

await Promise.allSettled(
	fileRoutes.map(async ({ parent, name }) => {
		console.info('Uploading schema', name);

		await cf.schemaValidation.schemas
			.create({
				kind: 'openapi_v3',
				name,
				source: await readFile([parent, name].join('/'), 'utf-8'),
				validation_enabled: true,
				zone_id: ZONE_ID,
			})
			.then(async () => {
				console.info('✅', 'Uploaded schema', name);
				console.info('Deleting old schemas', oldSchemas[name] ?? []);

				await Promise.allSettled([
					// Delete old schemas
					...(oldSchemas[name] ?? []).map(({ schema_id }) =>
						cf.schemaValidation.schemas
							.delete(schema_id, {
								zone_id: ZONE_ID,
							})
							.then(() => console.info('✅', 'Deleted old schema', name, `(${schema_id})`)),
					),
					// Set action to default (it hardcodes in the current default value)
				]).then((settled) => {
					const errored = settled.filter((result) => result.status === 'rejected');

					if (errored.length > 0) {
						// eslint-disable-next-line @typescript-eslint/no-unsafe-return
						throw new Error(JSON.stringify(errored.map((error) => error.reason)));
					}
				});
			});
	}),
).then((settled) => {
	const errored = settled.filter((result) => result.status === 'rejected');

	if (errored.length > 0) {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-return
		throw new Error(JSON.stringify(errored.map((error) => error.reason)));
	}
});

const [{ validation_default_mitigation_action }, operations] = await Promise.all([
	(async () => {
		console.info('Getting default API Gateway validation action');

		return cf.schemaValidation.settings.get({ zone_id: ZONE_ID });
	})(),
	(async () => {
		console.info('Getting existing API Gateway validation operations');

		const operations: OperationListResponse[] = [];

		for await (const operation of cf.schemaValidation.settings.operations.list({
			zone_id: ZONE_ID,
			/**
			 * @link https://developers.cloudflare.com/api/resources/schema_validation/subresources/settings/subresources/operations/methods/list/
			 */
			per_page: 50,
		})) {
			operations.push(operation);
		}

		return operations;
	})(),
]);

// By default the default action is hardcoded as the action
const hardcodedOperations = operations.filter((operation) => operation.mitigation_action === validation_default_mitigation_action);

console.info('Default API Gateway validation action', validation_default_mitigation_action);
console.info('Existing API Gateway validation operation with hardcoded default', hardcodedOperations.length);

await cf.schemaValidation.settings.operations
	.bulkEdit({
		zone_id: ZONE_ID,
		body: hardcodedOperations.reduce<OperationBulkEditParams['body']>(
			(acc, { operation_id }) => {
				// Set to literal `null` to return to pointer to default action
				acc[operation_id] = { mitigation_action: null };
				return acc;
			},
			{} satisfies OperationBulkEditParams['body'],
		),
	})
	.then(() => console.info('✅', 'Removed hardcoded default actions from operations'));
