import { unstable_startWorker } from 'wrangler';

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
	unstable_startWorker({ config: 'wrangler.jsonc' }),
]).then(([apiVersions, worker]) => {
	// Get the OpenAPI versions
	const openapiVersions = [
		// 3.0 has no version number
		'',
		'31',
	];

	console.info({ apiVersions, openapiVersions });

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
				.then((folderPath) =>
					Promise.allSettled(
						// Get each OpenAPI version
						openapiVersions.map((oV) => {
							const url = new URL([aV, 'generate', `openapi${oV}`].join('/'), 'http://localhost:8787');
							console.info(new Date().toISOString(), 'GET', `${url.pathname}${url.search}${url.hash}`);

							return worker.fetch(new URL([aV, 'generate', `openapi${oV}`].join('/'), 'http://localhost:8787')).then(async (response) => {
								console.info(new Date().toISOString(), response.status, `${url.pathname}${url.search}${url.hash}`);

								if (response.ok && response.body) {
									// Write the file to the asset directory
									return import('node:fs').then(async ({ createWriteStream }) => {
										// Use streaming to optimize memory usage
										const writeStream = createWriteStream([...folderPath, `openapi${oV}.json`].join('/'), { encoding: 'utf-8' });

										for await (const chunk of response.body) {
											writeStream.write(chunk);
										}

										writeStream.end();

										console.log('Wrote', aV, 'OpenAPI', oV === '' ? '30' : oV, 'to', response.status);
									});
								}
							});
						}),
					),
				),
		),
	).finally(() => worker.dispose());
});
