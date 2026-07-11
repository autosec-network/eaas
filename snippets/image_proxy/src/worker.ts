import { AutoRouter, error, StatusError, type IRequestStrict, type RequestHandler } from 'itty-router';
import * as z from 'zod/mini';

// const JsonSchema = z.union([z.looseObject({}), z.array(z.looseObject({}))]);
// const FormSchema = z.record(z.string(), z.any());
// const QuerySchema = z.record(z.string(), z.union([z.string(), z.array(z.string())]));
const ParamSchema = z.object({
	url: z.codec(
		z.codec(z.string(), z.url({ protocol: /^https?$/, hostname: z.regexes.domain }), {
			decode: (value, payload) => {
				try {
					return decodeURIComponent(value);
				} catch (error) {
					payload.issues.push({
						code: 'invalid_format',
						format: 'uriComponent',
						message: error instanceof URIError ? error.message : 'Invalid URI component',
						input: value,
					});
					return z.NEVER;
				}
			},
			encode: (value) => encodeURIComponent(value),
		}),
		z.instanceof(URL),
		{
			decode: (urlString) => new URL(urlString),
			encode: (url) => url.href,
		},
	),
});
// const HeaderSchema = z.record(
// 	z.union([
// 		/**
// 		 * @link https://www.iana.org/assignments/http-fields/http-fields.xhtml
// 		 */
// 		z.enum(['A-IM', 'Accept', 'Accept-Additions', 'Accept-CH', 'Accept-Charset', 'Accept-Datetime', 'Accept-Encoding', 'Accept-Features', 'Accept-Language', 'Accept-Patch', 'Accept-Post', 'Accept-Ranges', 'Accept-Signature', 'Access-Control', 'Access-Control-Allow-Credentials', 'Access-Control-Allow-Headers', 'Access-Control-Allow-Methods', 'Access-Control-Allow-Origin', 'Access-Control-Expose-Headers', 'Access-Control-Max-Age', 'Access-Control-Request-Headers', 'Access-Control-Request-Method', 'Age', 'Allow', 'ALPN', 'Alt-Svc', 'Alt-Used', 'Alternates', 'AMP-Cache-Transform', 'Apply-To-Redirect-Ref', 'Authentication-Control', 'Authentication-Info', 'Authorization', 'Available-Dictionary', 'C-Ext', 'C-Man', 'C-Opt', 'C-PEP', 'C-PEP-Info', 'Cache-Control', 'Cache-Status', 'Cal-Managed-ID', 'CalDAV-Timezones', 'Capsule-Protocol', 'CDN-Cache-Control', 'CDN-Loop', 'Cert-Not-After', 'Cert-Not-Before', 'Clear-Site-Data', 'Client-Cert', 'Client-Cert-Chain', 'Close', 'CMCD-Object', 'CMCD-Request', 'CMCD-Session', 'CMCD-Status', 'CMSD-Dynamic', 'CMSD-Static', 'Concealed-Auth-Export', 'Configuration-Context', 'Connection', 'Content-Base', 'Content-Digest', 'Content-Disposition', 'Content-Encoding', 'Content-ID', 'Content-Language', 'Content-Length', 'Content-Location', 'Content-MD5', 'Content-Range', 'Content-Script-Type', 'Content-Security-Policy', 'Content-Security-Policy-Report-Only', 'Content-Style-Type', 'Content-Type', 'Content-Version', 'Cookie', 'Cookie2', 'Cross-Origin-Embedder-Policy', 'Cross-Origin-Embedder-Policy-Report-Only', 'Cross-Origin-Opener-Policy', 'Cross-Origin-Opener-Policy-Report-Only', 'Cross-Origin-Resource-Policy', 'CTA-Common-Access-Token', 'DASL', 'Date', 'DAV', 'Default-Style', 'Delta-Base', 'Deprecation', 'Depth', 'Derived-From', 'Destination', 'Differential-ID', 'Dictionary-ID', 'Digest', 'DPoP', 'DPoP-Nonce', 'Early-Data', 'EDIINT-Features', 'ETag', 'Expect', 'Expect-CT', 'Expires', 'Ext', 'Forwarded', 'From', 'GetProfile', 'Hobareg', 'Host', 'HTTP2-Settings', 'If', 'If-Match', 'If-Modified-Since', 'If-None-Match', 'If-Range', 'If-Schedule-Tag-Match', 'If-Unmodified-Since', 'IM', 'Include-Referred-Token-Binding-ID', 'Isolation', 'Keep-Alive', 'Label', 'Last-Event-ID', 'Last-Modified', 'Link', 'Link-Template', 'Location', 'Lock-Token', 'Man', 'Max-Forwards', 'Memento-Datetime', 'Meter', 'Method-Check', 'Method-Check-Expires', 'MIME-Version', 'Negotiate', 'NEL', 'OData-EntityId', 'OData-Isolation', 'OData-MaxVersion', 'OData-Version', 'Opt', 'Optional-WWW-Authenticate', 'Ordering-Type', 'Origin', 'Origin-Agent-Cluster', 'OSCORE', 'OSLC-Core-Version', 'Overwrite', 'P3P', 'PEP', 'PEP-Info', 'Permissions-Policy', 'PICS-Label', 'Ping-From', 'Ping-To', 'Position', 'Pragma', 'Prefer', 'Preference-Applied', 'Priority', 'ProfileObject', 'Protocol', 'Protocol-Info', 'Protocol-Query', 'Protocol-Request', 'Proxy-Authenticate', 'Proxy-Authentication-Info', 'Proxy-Authorization', 'Proxy-Features', 'Proxy-Instruction', 'Proxy-Status', 'Public', 'Public-Key-Pins', 'Public-Key-Pins-Report-Only', 'Range', 'Redirect-Ref', 'Referer', 'Referer-Root', 'Referrer-Policy', 'Refresh', 'Repeatability-Client-ID', 'Repeatability-First-Sent', 'Repeatability-Request-ID', 'Repeatability-Result', 'Replay-Nonce', 'Reporting-Endpoints', 'Repr-Digest', 'Retry-After', 'Safe', 'Schedule-Reply', 'Schedule-Tag', 'Sec-GPC', 'Sec-Purpose', 'Sec-Token-Binding', 'Sec-WebSocket-Accept', 'Sec-WebSocket-Extensions', 'Sec-WebSocket-Key', 'Sec-WebSocket-Protocol', 'Sec-WebSocket-Version', 'Security-Scheme', 'Server', 'Server-Timing', 'Set-Cookie', 'Set-Cookie2', 'SetProfile', 'Signature', 'Signature-Input', 'SLUG', 'SoapAction', 'Status-URI', 'Strict-Transport-Security', 'Sunset', 'Surrogate-Capability', 'Surrogate-Control', 'TCN', 'TE', 'Timeout', 'Timing-Allow-Origin', 'Topic', 'Traceparent', 'Tracestate', 'Trailer', 'Transfer-Encoding', 'TTL', 'Upgrade', 'Urgency', 'URI', 'Use-As-Dictionary', 'User-Agent', 'Variant-Vary', 'Vary', 'Via', 'Want-Content-Digest', 'Want-Digest', 'Want-Repr-Digest', 'Warning', 'WWW-Authenticate', 'X-Content-Type-Options', 'X-Frame-Options']),
// 		z.string(),
// 	]),
// 	z.string(),
// );
// const CookieSchema = z.record(z.string(), z.string());

interface ZodRequest extends IRequestStrict {
	valid: {
		// json: () => Promise<z.output<typeof JsonSchema>>;
		// form: () => Promise<z.output<typeof FormSchema>>;
		// query: () => Promise<z.output<typeof QuerySchema>>;
		param: () => Promise<z.output<typeof ParamSchema>>;
		// header: () => Promise<z.output<typeof HeaderSchema>>;
		// cookie: () => Promise<z.output<typeof CookieSchema>>;
	};
}

const router = AutoRouter<ZodRequest>();

const withZod: RequestHandler<ZodRequest> = (request) => {
	request.valid = {
		// json: async () =>
		// 	JsonSchema.safeParseAsync(await request.json()).then((result) => {
		// 		if (result.success) {
		// 			return result.data;
		// 		} else {
		// 			throw new StatusError(400, z.treeifyError(result.error));
		// 		}
		// 	}),
		// form: async () =>
		// 	FormSchema.safeParseAsync(await request.formData()).then((result) => {
		// 		if (result.success) {
		// 			return result.data;
		// 		} else {
		// 			throw new StatusError(400, z.treeifyError(result.error));
		// 		}
		// 	}),
		// query: () =>
		// 	QuerySchema.safeParseAsync(new URL(request.url).search).then((result) => {
		// 		if (result.success) {
		// 			return result.data;
		// 		} else {
		// 			throw new StatusError(400, z.treeifyError(result.error));
		// 		}
		// 	}),
		param: () =>
			ParamSchema.safeParseAsync(Object.fromEntries(new URL(request.url).searchParams.entries())).then((result) => {
				if (result.success) {
					return result.data;
				} else {
					throw new StatusError(400, z.treeifyError(result.error));
				}
			}),
		// header: () =>
		// 	HeaderSchema.safeParseAsync(Object.fromEntries(request.headers.entries())).then((result) => {
		// 		if (result.success) {
		// 			return result.data;
		// 		} else {
		// 			throw new StatusError(400, z.treeifyError(result.error));
		// 		}
		// 	}),
		// cookie: () => {
		// 	const cookies = (request.headers.get('cookie') ?? '').split(';').reduce(
		// 		(acc, pair) => {
		// 			const [key, ...val] = pair.split('=');
		// 			if (key?.trim()) {
		// 				acc[key.trim().toLowerCase()] = val.join('=').trim();
		// 			}
		// 			return acc;
		// 		},
		// 		{} as Record<string, string>,
		// 	);
		// 	return CookieSchema.safeParseAsync(cookies).then((result) => {
		// 		if (result.success) {
		// 			return result.data;
		// 		} else {
		// 			throw new StatusError(400, z.treeifyError(result.error));
		// 		}
		// 	});
		// },
	};
};

const proxyHandler: RequestHandler<ZodRequest> = async (request) => {
	const { url } = await request.valid.param();

	const upstream = await fetch(url, {
		method: request.method === 'HEAD' ? 'HEAD' : 'GET',
		headers: {
			'User-Agent': `Autosec-Image-Proxy/1.0 (${['CloudflareSnippets', ...(request.cf ? [`Colo=${(request.cf as IncomingRequestCfPropertiesBase).colo}`] : []), `+${new URL(request.url).origin}`].join('; ')})`,
			Accept: 'image/*',
			...(request.headers.has('Accept-Encoding') && { 'Accept-Encoding': request.headers.get('Accept-Encoding')! }),
			...(request.headers.has('Accept-Language') && { 'Accept-Language': request.headers.get('Accept-Language')! }),
		},
		signal: request.signal,
		cf: {
			/**
			 * Treats all content as static and caches all file types beyond the Cloudflare default cached content. Respects cache headers from the origin web server. This is equivalent to setting the Page Rule Cache Level (to Cache Everything).
			 * Cache Everything: Treats all content as static and caches all file types beyond the Cloudflare default cached content. Respects cache headers from the origin web server unless Edge Cache TTL is also set in the Page Rule. When combined with an Edge Cache TTL > 0, Cache Everything removes cookies from the origin web server response.
			 * @link https://developers.cloudflare.com/cache/concepts/default-cache-behavior/#default-cached-file-extensions
			 * @default false
			 * This option applies to GET and HEAD request methods only.
			 */
			cacheEverything: true,
			/**
			 * Sets Polish mode. The possible values are lossy, lossless or off
			 * @link https://blog.cloudflare.com/introducing-polish-automatic-image-optimizati/
			 */
			polish: 'lossless',
		},
	});

	// Validate the MIME type for both HEAD and GET requests
	if (!(upstream.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase().startsWith('image/') ?? false)) {
		throw new StatusError(415, 'Content is not a valid image format');
	}

	const newHeaders = new Headers(upstream.headers);
	newHeaders.set('Access-Control-Allow-Origin', '*');
	newHeaders.set('Vary', 'Accept');
	// Drop for safety reasons
	newHeaders.delete('Set-Cookie');
	newHeaders.delete('Location');
	newHeaders.delete('Refresh');

	return new Response(upstream.body, { ...upstream, headers: newHeaders });
};

router
	.get('*', withZod, proxyHandler)
	.head('*', withZod, proxyHandler)
	.options('*', withZod, async (request) => {
		await request.valid.param();

		return new Response(null, {
			status: 204,
			headers: {
				'Access-Control-Allow-Origin': '*',
				'Access-Control-Allow-Methods': ['GET', 'HEAD', 'OPTIONS'].join(', '),
				'Access-Control-Allow-Headers': '*',
				// hours * minutes * seconds
				'Access-Control-Max-Age': `${24 * 60 * 60}`,
			},
		});
	});

export default {
	fetch: (request) => router.fetch(request).catch(error),
} satisfies ExportedHandler;
