import { Cloudflare } from 'cloudflare';
import type { CustomLoging } from '../types/index.mjs';
import { CryptoHelpers } from './crypto.mjs';

export class NetHelpers {
	/**
	 * Removes the `body` property from a RequestInit object to reduce verbosity when logging.
	 *
	 * @param {RequestInit} [init={}] - The RequestInit object from which to remove the 'body' property. If not provided, an empty object will be used.
	 *
	 * @returns {RequestInit} The updated RequestInit object without the 'body' property.
	 */
	public static initBodyTrimmer(init: RequestInit = {}): RequestInit {
		if ('cf' in init) delete init.cf;
		delete init.body;
		return init;
	}

	public static stripSensitiveHeaders(originalHeaders: Headers = new Headers()) {
		originalHeaders.delete('Set-Cookie');
		originalHeaders.delete('Authorization');

		return originalHeaders;
	}

	public static cfApi(apiKey: string, cacheTtl?: number, logger: CustomLoging = false) {
		return new Cloudflare({
			apiToken: apiKey,
			fetch: (info, init) =>
				// eslint-disable-next-line @typescript-eslint/no-misused-promises
				new Promise<Awaited<ReturnType<typeof fetch>>>(async (resolve) => {
					const cacheKey = new Request(info, { ...init, headers: this.stripSensitiveHeaders(new Headers(init?.headers)) });
					if (typeof logger === 'boolean') {
						if (logger) {
							await import('chalk')
								.then(({ Chalk }) => {
									const chalk = new Chalk({ level: 1 });
									console.debug(chalk.magenta('CF Fetch request'), chalk.magenta(cacheKey.url), JSON.stringify(this.initBodyTrimmer({ ...init, headers: Object.fromEntries(this.stripSensitiveHeaders(new Headers(init?.headers)).entries()) }), null, '\t'));
								})
								.catch(() => console.debug('CF Fetch request', cacheKey.url, JSON.stringify(this.initBodyTrimmer({ ...init, headers: Object.fromEntries(this.stripSensitiveHeaders(new Headers(init?.headers)).entries()) }), null, '\t')));
						}
					} else {
						logger(`CF Fetch request ${cacheKey.url} ${JSON.stringify(this.initBodyTrimmer({ ...init, headers: Object.fromEntries(this.stripSensitiveHeaders(new Headers(init?.headers)).entries()) }), null, '\t')}`);
					}

					if (cacheTtl) {
						const cfCacheRef: Promise<Cache> | undefined = caches.open('cfApi');
						// eslint-disable-next-line @typescript-eslint/no-misused-promises
						if (cfCacheRef) {
							await cfCacheRef
								.then((cfCache) =>
									cfCache
										.match(cacheKey)
										.then(async (cachedResponse) => {
											if (cachedResponse) {
												if (typeof logger === 'boolean') {
													if (logger) {
														await import('chalk')
															.then(({ Chalk }) => {
																const chalk = new Chalk({ level: 1 });
																console.debug(chalk.green('CF Cache hit'), cacheKey.url);
															})
															.catch(() => console.debug('CF Cache hit', cacheKey.url));
													}
												} else {
													logger(`CF Cache hit ${cacheKey.url}`);
												}

												if (cachedResponse.status < 500) {
													resolve(cachedResponse);
												} else {
													void cfCache.delete(cacheKey).then(() => resolve(cachedResponse));
												}
											} else {
												if (typeof logger === 'boolean') {
													if (logger) {
														await import('chalk')
															.then(({ Chalk }) => {
																const chalk = new Chalk({ level: 1 });
																console.warn(chalk.yellow('CF Cache missed'), cacheKey.url);
															})
															.catch(() => console.warn('CF Cache missed', cacheKey.url));
													}
												} else {
													logger(`CF Cache missed ${cacheKey.url}`);
												}

												await this.loggingFetch(info, init, undefined, logger)
													.then((response) => {
														resolve(response.clone());
														return response;
													})
													.then((response) => {
														if (response.status < 500) {
															response = new Response(response.body, response);
															response.headers.set('Cache-Control', `s-maxage=${cacheTtl}`);

															if (response.headers.has('ETag')) {
																return cfCache.put(cacheKey, response).then(async () => {
																	if (typeof logger === 'boolean') {
																		if (logger) {
																			await import('chalk')
																				.then(({ Chalk }) => {
																					const chalk = new Chalk({ level: 1 });
																					console.debug(chalk.gray('CF Cache saved'), cacheKey.url);
																				})
																				.catch(() => console.debug('CF Cache saved', cacheKey.url));
																		}
																	} else {
																		logger(`CF Cache saved ${cacheKey.url}`);
																	}
																});
															} else {
																return (
																	CryptoHelpers.generateETag(response)
																		.then((etag) => response.headers.set('ETag', etag))
																		// eslint-disable-next-line @typescript-eslint/no-misused-promises
																		.finally(() =>
																			cfCache.put(cacheKey, response).then(async () => {
																				if (typeof logger === 'boolean') {
																					if (logger) {
																						await import('chalk')
																							.then(({ Chalk }) => {
																								const chalk = new Chalk({ level: 1 });
																								console.debug(chalk.gray('CF Cache saved'), cacheKey.url);
																							})
																							.catch(() => console.debug('CF Cache saved', cacheKey.url));
																					}
																				} else {
																					logger(`CF Cache saved ${cacheKey.url}`);
																				}
																			}),
																		)
																);
															}
														} else {
															return;
														}
													});
											}
										})
										.catch(async (error) => {
											if (typeof logger === 'boolean') {
												if (logger) {
													await import('chalk')
														.then(({ Chalk }) => {
															const chalk = new Chalk({ level: 1 });
															console.error(chalk.red('CF Cache match error'), error);
														})
														.catch(() => console.error('CF Cache match error', error));
												}
											} else {
												logger(`CF Cache match error ${error}`);
											}

											resolve(this.loggingFetch(info, init, undefined, logger));
										}),
								)
								.catch(async (error) => {
									if (typeof logger === 'boolean') {
										if (logger) {
											await import('chalk')
												.then(({ Chalk }) => {
													const chalk = new Chalk({ level: 1 });
													console.error(chalk.red('CF Cache open error'), error);
												})
												.catch(() => console.error('CF Cache open error', error));
										}
									} else {
										logger(`CF Cache open error ${error}`);
									}

									resolve(this.loggingFetch(info, init, undefined, logger));
								});
						} else {
							if (typeof logger === 'boolean') {
								if (logger) {
									await import('chalk')
										.then(({ Chalk }) => {
											const chalk = new Chalk({ level: 1 });
											console.warn(chalk.yellow('CF Cache not available'));
										})
										.catch(() => console.warn('CF Cache not available'));
								}
							} else {
								logger('CF Cache not available');
							}

							resolve(this.loggingFetch(info, init, undefined, logger));
						}
					} else {
						if (typeof logger === 'boolean') {
							if (logger) {
								await import('chalk')
									.then(({ Chalk }) => {
										const chalk = new Chalk({ level: 1 });
										console.warn(chalk.yellow('CF Cache ignored'), cacheKey.url);
									})
									.catch(() => console.warn('CF Cache ignored', cacheKey.url));
							}
						} else {
							logger(`CF Cache ignored ${cacheKey.url}`);
						}
						resolve(this.loggingFetch(info, init, undefined, logger));
					}
				}),
		});
	}

	public static loggingFetch(info: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1], body = false, logger: CustomLoging = false) {
		// eslint-disable-next-line @typescript-eslint/no-misused-promises
		return new Promise<Awaited<ReturnType<typeof fetch>>>((resolve, reject) =>
			fetch(info, init)
				.then(async (response) => {
					resolve(response.clone());

					// Allow mutable headers
					response = new Response(response.body, response);
					const loggingContent: Record<string, any> = {
						headers: Object.fromEntries(this.stripSensitiveHeaders(response.headers).entries()),
						status: response.status,
						statusText: response.statusText,
						ok: response.ok,
						type: response.type,
					};
					if (body) {
						if (response.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
							// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
							loggingContent['body'] = await response.json();
						} else {
							loggingContent['body'] = await response.text();
						}
					}

					if (typeof logger === 'boolean') {
						if (logger) {
							await import('chalk')
								.then(({ Chalk }) => {
									const chalk = new Chalk({ level: 1 });
									// eslint-disable-next-line @typescript-eslint/no-base-to-string
									console.debug(response.ok ? chalk.green('Fetch response') : chalk.red('Fetch response'), response.ok, response.ok ? chalk.green(response.url || info.toString()) : chalk.red(response.url || info.toString()), JSON.stringify(loggingContent, null, '\t'));
								})
								// eslint-disable-next-line @typescript-eslint/no-base-to-string
								.catch(() => console.debug('Fetch response', response.ok, response.url || info.toString(), JSON.stringify(loggingContent, null, '\t')));
						}
					} else {
						// eslint-disable-next-line @typescript-eslint/no-base-to-string
						logger(`Fetch response ${response.ok} ${response.url || info.toString()} ${JSON.stringify(loggingContent, null, '\t')}`);
					}
				})
				.catch(reject),
		);
	}

	/**
	 * Parses the Server-Timing header and returns an object with the metrics.
	 * The object keys are the metric names (with optional descriptions), and the values are the duration of each metric or null if no duration is found.
	 *
	 * @param {string} [serverTimingHeader=''] - The Server-Timing header string.
	 * @returns {Record<string, number | null>} An object where keys are metric names (with optional descriptions) and values are the durations in milliseconds or null.
	 */
	public static serverTiming(serverTimingHeader = '') {
		const result: Record<string, number | null> = {};

		if (serverTimingHeader && serverTimingHeader.trim().length > 0) {
			// Split the header by comma to get each metric
			const metrics = serverTimingHeader.trim().split(',');

			metrics.forEach((metric) => {
				// Split each metric by semicolon to separate the name from other attributes
				const parts = metric.split(';').map((part) => part.trim());

				// Get the metric name
				const name = parts[0];

				// Find the 'dur' attribute and convert it to a number
				const durationPart = parts.find((part) => part.startsWith('dur='));
				const duration = durationPart ? parseFloat(durationPart.split('=')[1]!) : null;

				// Optionally find the 'desc' attribute
				const descriptionPart = parts.find((part) => part.startsWith('desc='));
				const description = descriptionPart ? descriptionPart.split('=')[1] : null;

				// Construct the key name with optional description
				const keyName = description ? `${name} (${description})` : name;

				if (name) {
					result[keyName!] = duration;
				}
			});
		}

		return result;
	}
}
