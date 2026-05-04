import { createMarkdownFromOpenApi } from '@scalar/openapi-to-markdown';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { unstable_startWorker } from 'wrangler';

// Read route paths directly
const apiVersions = await readdir('src', { withFileTypes: true }).then((entries) =>
	entries
		// Get only directories
		.filter((entry) => entry.isDirectory())
		// Get only the version directories
		.filter((dir) => dir.name.startsWith('v'))
		// Get only the name
		.map((dir) => dir.name),
);

console.info({ apiVersions });

/**
 * Main `llms.txt`
 * Use streaming to optimize memory usage
 */
const writeStream = createWriteStream(['dist', 'llms.txt'].join('/'), { encoding: 'utf-8' });

// Create root llms.txt as a pointer to each API version's llms.txt
writeStream.write('# EaaS (Encryption as a Service) API Documentation\n\n');
writeStream.write('This service provides multiple API versions. Each version has its own detailed documentation:\n\n');

// Generate links to each version's llms.txt
for (const version of apiVersions) {
	writeStream.write(`## API ${version.toUpperCase()}\n\n`);
	writeStream.write(`Full API documentation for ${version}: [${version}/llms.txt](/${version}/llms.txt)\n\n`);
}

writeStream.write('---\n\n');
writeStream.write('Generated automatically from OpenAPI specifications.\n');

writeStream.end();

console.log('Wrote root llms.txt with pointers to', apiVersions.length, 'API versions');

/**
 * Replace all `remote: true` with `remote: false` in wrangler.jsonc to prevent auth errors (remote resource access not needed just to generate OpenAPI specs)
 */
const configPath = 'wrangler.jsonc';
const content = await readFile(configPath, 'utf-8');
const updatedContent = content.replaceAll('"remote": true', '"remote": false');
await writeFile(configPath, updatedContent, 'utf-8');
console.log('Disabled all remote mode in wrangler.jsonc');

const worker = await unstable_startWorker({
	config: 'wrangler.jsonc',
	build: {
		minify: true,
		keepNames: false,
		nodejsCompatMode: 'v2',
	},
	dev: {
		inspector: false,
		liveReload: false,
		watch: false,
		remote: false,
		persist: '../.wrangler/state',
	},
});

await Promise.allSettled(
	// Loop through the API versions
	apiVersions.map(async (aV) => {
		// Create the folder for the API version
		const folderPath = ['dist', aV];

		await mkdir(folderPath.join('/'), { recursive: true }).then((folder) => console.log('Created folder', folder));

		const openapiVersions = [
			// Get the OpenAPI versions
			'openapi',
			'openapi31',
			`${aV}.eaas.cf-apig.openapi`,
		];

		console.info({ openapiVersions });

		await Promise.allSettled([
			// Get each OpenAPI schema
			...openapiVersions.map(async (oV) => {
				const url = new URL([aV, 'generate', oV].join('/'), (await worker.url).origin);
				console.info(new Date().toISOString(), 'GET', `${url.pathname}${url.search}${url.hash}`);

				await worker.ready;

				await worker
					.fetch(
						// @ts-expect-error URL is the same type
						url,
					)
					.then(async (response) => {
						console.info(new Date().toISOString(), response.status, `${url.pathname}${url.search}${url.hash}`);

						if (response.ok && response.body !== null) {
							/**
							 * Write the file to the asset directory
							 * Use streaming to optimize memory usage
							 */
							const writeStream = createWriteStream([...folderPath, `${oV}.json`].join('/'), { encoding: 'utf-8' });

							for await (const chunk of response.body) {
								writeStream.write(chunk);
							}

							writeStream.end();

							console.log('Wrote', aV, 'OpenAPI', oV === '' ? '30' : oV, 'to', response.status);
						}
					});
			}),
			// Version specific llms.txt
			(async () => {
				const url = new URL([aV, 'generate', 'openapi31'].join('/'), (await worker.url).origin);
				console.info(new Date().toISOString(), 'GET', `${url.pathname}${url.search}${url.hash}`);

				await worker.ready;

				await worker
					.fetch(
						// @ts-expect-error URL is the same type
						url,
					)
					.then(async (response) => {
						console.info(new Date().toISOString(), response.status, `${url.pathname}${url.search}${url.hash}`);

						if (response.ok) {
							await writeFile([...folderPath, `llms.txt`].join('/'), await createMarkdownFromOpenApi(await response.text()), { encoding: 'utf-8' });

							console.log('Wrote', aV, 'llms.txt', response.status);
						}
					});
			})(),
		]);
	}),
).finally(() => worker.dispose());

process.exit(0);
