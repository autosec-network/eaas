/**
 * This is the base config for vite.
 * When building, the adapter config is used which loads this file and extends it.
 */
import { qwikCity } from '@builder.io/qwik-city/vite';
import { qwikVite } from '@builder.io/qwik/optimizer';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import { defineConfig, type UserConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';
import type { EnvVars } from '~/types';

/**
 * @link https://developers.cloudflare.com/workers/runtime-apis/nodejs
 */
const cloudflareNodeRuntimes: `node:${string}`[] = ['node:assert', 'node:async_hooks', 'node:buffer', 'node:crypto', 'node:diagnostics_channel', 'node:events', 'node:path', 'node:process', 'node:stream', 'node:string_decoder', 'node:test', 'node:url', 'node:util', 'node:zlib'];
/**
 * @link https://workers-types.pages.dev/
 */
const cloudflareRuntimes: `cloudflare:${string}`[] = ['cloudflare:email', 'cloudflare:workers', 'cloudflare:sockets'];

export default defineConfig((): UserConfig => {
	return {
		plugins: [
			qwikCity(),
			qwikVite(),
			tsconfigPaths(),
			nodeResolve({
				browser: true,
				modulesOnly: true,
				preferBuiltins: true,
			}),
		],
		server: {
			headers: {
				// Don't cache the server response in dev mode
				'Cache-Control': 'public, max-age=0',
			},
		},
		preview: {
			headers: {
				// Do cache the server response in preview (non-adapter production build)
				'Cache-Control': 'public, max-age=600',
			},
		},
		build: {
			target: 'esnext',
			sourcemap: (process.env as EnvVars).NODE_ENV !== 'production',
			emptyOutDir: true,
			rollupOptions: {
				external: ['crypto', ...cloudflareNodeRuntimes, ...cloudflareRuntimes],
			},
			manifest: true,
		},
		worker: {
			rollupOptions: {
				external: ['crypto', ...cloudflareNodeRuntimes, ...cloudflareRuntimes],
			},
		},
		ssr: {
			external: ['crypto', ...cloudflareNodeRuntimes, ...cloudflareRuntimes],
		},
		// This tells Vite which dependencies to pre-build in dev mode.
		optimizeDeps: {
			include: ['@auth/core'],
			// Put problematic deps that break bundling here, mostly those with binaries.
			// For example ['better-sqlite3'] if you use that in server functions.
			exclude: ['crypto', ...cloudflareNodeRuntimes, ...cloudflareRuntimes],
		},
	};
});
