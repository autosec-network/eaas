import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import eslintPluginZod from 'eslint-plugin-zod';
import eslintPluginZodMini from 'eslint-plugin-zod-mini';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig({
	// config with just ignores is the replacement for `.eslintignore`
	ignores: ['dist/*', 'server/*', 'tmp/*', '**/worker-configuration.d.ts'],
	extends: [eslint.configs.recommended, tseslint.configs.recommendedTypeChecked, tseslint.configs.stylisticTypeChecked, eslintConfigPrettier],
	plugins: {
		'@typescript-eslint': tseslint.plugin,
		zod: eslintPluginZod,
		'zod-mini': eslintPluginZodMini,
	},
	languageOptions: {
		parser: tseslint.parser,
		parserOptions: {
			ecmaVersion: 'latest',
			jsDocParsingMode: 'type-info',
			lib: ['esnext'],
			projectService: {
				allowDefaultProject: ['eslint.config.mjs'],
				defaultProject: 'tsconfig.json',
			},
			tsconfigRootDir: import.meta.dirname,
		},
	},
	rules: {
		...eslintPluginZod.configs.recommended.rules,
		...eslintPluginZodMini.configs.recommended.rules,
		'zod/array-style': ['error', { style: 'function' }],
		'zod/consistent-import-source': ['error', { sources: ['zod/v4'] }],
		'zod-mini/consistent-import-source': ['error', { sources: ['zod/mini'] }],
		'zod/no-any-schema': 'warn',
		'zod/no-empty-custom-schema': 'warn',
		'zod/require-error-message': 'warn',
		'zod-mini/require-error-message': 'warn',
		'@typescript-eslint/no-explicit-any': 'warn',
		'@typescript-eslint/explicit-module-boundary-types': 'off',
		'@typescript-eslint/no-inferrable-types': 'off',
		'@typescript-eslint/no-non-null-assertion': 'off',
		'@typescript-eslint/no-empty-interface': 'off',
		'@typescript-eslint/no-namespace': 'off',
		'@typescript-eslint/no-empty-function': 'off',
		'@typescript-eslint/no-this-alias': 'off',
		'@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'with-single-extends' }],
		'prefer-spread': 'off',
		'no-case-declarations': 'off',
		'no-console': 'off',
		// Note: you must disable the base rule as it can report incorrect errors
		'no-unused-vars': 'off',
		'@typescript-eslint/no-unused-vars': 'warn',
		'@typescript-eslint/no-unnecessary-condition': 'warn',
		'@typescript-eslint/no-import-type-side-effects': 'error',
		'@typescript-eslint/consistent-type-imports': 'error',
		'no-async-promise-executor': 'off',
	},
});
