import drizzlePlugin from 'eslint-plugin-drizzle';
import { qwikEslint9Plugin } from 'eslint-plugin-qwik';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import rootConfig from '../../eslint.config.mjs';

export default defineConfig({
	ignores: ['dist/*', 'server/*', 'tmp/*', 'worker-configuration.d.ts'],
	extends: [rootConfig, qwikEslint9Plugin.configs.recommended],
	plugins: {
		'@typescript-eslint': tseslint.plugin,
		drizzle: drizzlePlugin,
	},
	languageOptions: {
		parserOptions: {
			projectService: {
				allowDefaultProject: ['eslint.config.mjs'],
			},
			tsconfigRootDir: import.meta.dirname,
			ecmaFeatures: {
				jsx: true,
			},
		},
	},
	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
	rules: {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
		...drizzlePlugin.configs.recommended.rules,
		'@typescript-eslint/only-throw-error': 'off',
	},
});
