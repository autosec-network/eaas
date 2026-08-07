/**
 * CSP `img-src` only allows `'self'` and `gravatar.com`, so any tenant-supplied avatar URL must be routed through the same-origin `/image/proxy` route instead of being set directly as an `<img src>`.
 */
export function proxiedImageUrl(origin: string, src: string): string {
	const proxyUrl = new URL('/image/proxy', origin);
	proxyUrl.searchParams.set('url', src);
	return proxyUrl.href;
}
