import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import rootConfig from '../../eslint.config.mjs';

export default defineConfig({
	extends: [rootConfig],
	plugins: {
		'@typescript-eslint': tseslint.plugin,
	},
	languageOptions: {
		parserOptions: {
			projectService: {
				allowDefaultProject: ['eslint.config.mjs'],
			},
			tsconfigRootDir: import.meta.dirname,
		},
	},
	rules: {},
});
