import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import tseslint from 'typescript-eslint';

export default tseslint.config({
	// config with just ignores is the replacement for `.eslintignore`
	ignores: ['dist/*', 'server/*', 'tmp/*'],
	extends: [eslint.configs.recommended, ...tseslint.configs.recommendedTypeChecked, ...tseslint.configs.stylisticTypeChecked, eslintConfigPrettier],
	plugins: {
		'@typescript-eslint': tseslint.plugin,
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
		'@typescript-eslint/no-explicit-any': 'off',
		'@typescript-eslint/explicit-module-boundary-types': 'off',
		'@typescript-eslint/no-inferrable-types': 'off',
		'@typescript-eslint/no-non-null-assertion': 'off',
		'@typescript-eslint/no-empty-interface': 'off',
		'@typescript-eslint/no-namespace': 'off',
		'@typescript-eslint/no-empty-function': 'off',
		'@typescript-eslint/no-this-alias': 'off',
		'@typescript-eslint/ban-types': 'off',
		'@typescript-eslint/ban-ts-comment': 'off',
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
