await Promise.all([
	// Read route paths directly
	import('node:fs/promises').then(({ readdir }) =>
		readdir('src', { withFileTypes: true }).then((entries) =>
			entries
				// Get only directories
				.filter((entry) => entry.isDirectory())
				// Get only the version directories
				.filter((dir) => dir.name.startsWith('v'))
				// Get only the name
				.map((dir) => dir.name),
		),
	),
	import('wrangler').then(({ unstable_startWorker }) => unstable_startWorker({ config: 'wrangler.jsonc', dev: { remote: false, liveReload: false, watch: false } })),
])
	.then(async ([apiVersions, worker]) => {
		console.info({ apiVersions });

		await import('node:fs').then(async ({ createWriteStream }) => {
			// Use streaming to optimize memory usage
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
		});

		return Promise.allSettled(
			// Loop through the API versions
			apiVersions.map((aV) =>
				// Create the folder for the API version
				import('node:fs/promises')
					.then(({ mkdir }) => {
						const folderPath = ['dist', aV];

						return mkdir(folderPath.join('/'), { recursive: true }).then((folder) => {
							console.log('Created folder', folder);

							return folderPath;
						});
					})
					.then((folderPath) => {
						const openapiVersions = [
							// Get the OpenAPI versions
							'openapi',
							'openapi31',
							`v0.cf-aig.openapi`,
						];

						console.info({ openapiVersions });

						return Promise.allSettled([
							// Get each OpenAPI version
							...openapiVersions.map(async (oV) => {
								await worker.ready;

								const url = new URL([aV, 'generate', oV].join('/'), (await worker.url).origin);
								console.info(new Date().toISOString(), 'GET', `${url.pathname}${url.search}${url.hash}`);

								return worker.fetch(url).then(async (response) => {
									console.info(new Date().toISOString(), response.status, `${url.pathname}${url.search}${url.hash}`, await response.clone().json());

									if (response.ok && response.body !== null) {
										// Write the file to the asset directory
										return import('node:fs').then(async ({ createWriteStream }) => {
											// Use streaming to optimize memory usage
											const writeStream = createWriteStream([...folderPath, `${oV}.json`].join('/'), { encoding: 'utf-8' });

											for await (const chunk of response.body) {
												writeStream.write(chunk);
											}

											writeStream.end();

											console.log('Wrote', aV, 'OpenAPI', oV === '' ? '30' : oV, 'to', response.status);
										});
									}
								});
							}),
							(async () => {
								await worker.ready;

								const url = new URL([aV, 'generate', 'openapi31'].join('/'), (await worker.url).origin);
								console.info(new Date().toISOString(), 'GET', `${url.pathname}${url.search}${url.hash}`);

								return worker.fetch(url).then(async (response) => {
									console.info(new Date().toISOString(), response.status, `${url.pathname}${url.search}${url.hash}`);

									if (response.ok) {
										// Write the file to the asset directory
										return import('node:fs').then(async ({ createWriteStream }) => {
											// Use streaming to optimize memory usage
											const writeStream = createWriteStream([...folderPath, `llms.txt`].join('/'), { encoding: 'utf-8' });

											writeStream.write(await Promise.all([import('@scalar/openapi-to-markdown'), response.text()]).then(([{ createMarkdownFromOpenApi }, openapi31]) => createMarkdownFromOpenApi(openapi31)));

											writeStream.end();

											console.log('Wrote', aV, 'llms.txt', 'to', response.status);
										});
									}
								});
							})(),
						]);
					}),
			),
		).finally(() => worker.dispose());
	})
	.then(() => process.exit(0));
