export async function startAndWaitForPort(container: Container, portToAwait: number, maxTries = 10) {
	const port = container.getTcpPort(portToAwait);
	// promise to make sure the container does not exit
	let monitor;

	for (let i = 0; i < maxTries; i++) {
		try {
			if (!container.running) {
				container.start();

				// force DO to keep track of running state
				monitor = container.monitor();
			}

			await (await port.fetch('http://ping')).text();
			return;
		} catch (err) {
			console.error('Error connecting to the container on', i, 'try', err);

			if (err.message.includes('listening')) {
				await new Promise((res) => setTimeout(res, 300));
				continue;
			}

			// no container yet
			if (err.message.includes('there is no container instance that can be provided')) {
				await new Promise((res) => setTimeout(res, 300));
				continue;
			}

			throw err;
		}
	}

	throw new Error(`could not check container healthiness after ${maxTries} tries`);
}

export async function proxyFetch(container: Container, request: Request, portNumber: number) {
	return await container.getTcpPort(portNumber).fetch(
		request.url.replace('https://', 'http://'),
		// @ts-expect-error
		request.clone(),
	);
}

export async function loadBalance(containerBinding: DurableObjectNamespace, count: number) {
	let randomID = Math.floor(Math.random() * count);
	let id = containerBinding.idFromName('lb-' + randomID);
	return containerBinding.get(id);
}
