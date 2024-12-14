module.exports = {
	env: {
		browser: true,
		serviceworker: true,
		node: true,
		// https://eslint.org/docs/head/use/configure/language-options-deprecated#specifying-environments
		es2024: true,
	},
	extends: ['../.eslintrc.cjs'],
	parserOptions: {
		tsconfigRootDir: __dirname,
		project: ['./tsconfig.json'],
		ecmaVersion: 'latest',
		sourceType: 'module',
	},
	plugins: [],
	rules: {},
};
